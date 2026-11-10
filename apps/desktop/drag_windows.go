//go:build windows

package main

import (
	"math"
	"syscall"
	"unsafe"
)

var (
	user32               = syscall.NewLazyDLL("user32.dll")
	procGetWindowRect    = user32.NewProc("GetWindowRect")
	procSetWindowPos     = user32.NewProc("SetWindowPos")
	procGetCursorPos     = user32.NewProc("GetCursorPos")
	procGetDpiForWindow  = user32.NewProc("GetDpiForWindow")
	procGetSystemMetrics = user32.NewProc("GetSystemMetrics")
	procSystemParams     = user32.NewProc("SystemParametersInfoW")
)

type winRect struct{ left, top, right, bottom int32 }

type winPoint struct{ x, y int32 }

const (
	swpNoSize     = 0x0001
	swpNoZOrder   = 0x0004
	swpNoActivate = 0x0010

	smXVirtualScreen  = 76
	smYVirtualScreen  = 77
	smCXVirtualScreen = 78
	smCYVirtualScreen = 79

	spiGetWorkArea = 0x0030

	// keepVisible is how many DIPs of the window stay on screen when it is
	// dragged towards an edge — enough to always have something to grab.
	keepVisible = 80
)

func windowRect(hwnd uintptr) (winRect, bool) {
	var r winRect
	if ok, _, _ := procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&r))); ok == 0 {
		return r, false
	}
	if r.right <= r.left || r.bottom <= r.top {
		return r, false
	}
	return r, true
}

func windowScale(hwnd uintptr) float64 {
	if dpi, _, _ := procGetDpiForWindow.Call(hwnd); dpi != 0 {
		return float64(dpi) / 96
	}
	return 1
}

// moveByWindow moves the window by dx, dy DIPs and keeps a strip of it on
// screen: the page drags her by the mouse, and without this she can be
// dropped off the edge with nothing left to grab.
func moveByWindow(hwnd uintptr, dx, dy float64) {
	if hwnd == 0 {
		return
	}
	r, ok := windowRect(hwnd)
	if !ok {
		return
	}
	scale := windowScale(hwnd)
	width := float64(r.right - r.left)
	x := float64(r.left) + dx*scale
	y := float64(r.top) + dy*scale

	vx, _, _ := procGetSystemMetrics.Call(smXVirtualScreen)
	vy, _, _ := procGetSystemMetrics.Call(smYVirtualScreen)
	vw, _, _ := procGetSystemMetrics.Call(smCXVirtualScreen)
	vh, _, _ := procGetSystemMetrics.Call(smCYVirtualScreen)
	keep := float64(keepVisible) * scale

	left := float64(int32(vx)) - width + keep
	right := float64(int32(vx)+int32(vw)) - keep
	top := float64(int32(vy))
	bottom := float64(int32(vy)+int32(vh)) - keep
	x = math.Max(left, math.Min(right, x))
	y = math.Max(top, math.Min(bottom, y))

	procSetWindowPos.Call(
		hwnd,
		0,
		uintptr(int32(math.Round(x))),
		uintptr(int32(math.Round(y))),
		0,
		0,
		swpNoSize|swpNoZOrder|swpNoActivate,
	)
}

// gazeReach 是「指多远算看到边」——取窗口长边的一半再乘上它。窗口本身很高，
// 按半宽归一的话屏幕正上方一点点就把她顶成满格抬头；按长边算，鼠标停在屏幕中间
// 时她基本是平视。
const gazeReach = 1.6

// gazeDead 是中间那一圈不动区：指针在窗口中心附近时头不该有一点抽动。
const gazeDead = 0.18

// cursorGaze says where the cursor is relative to the window's centre: -1..1,
// positive x right, positive y up (Live2D's convention).
//
// The page cannot work this out itself: most of the window is click-through,
// so the pointer never reports a position over it, and her head froze at
// whatever it was the last time the pointer crossed her.
func cursorGaze(hwnd uintptr) (float64, float64) {
	r, ok := windowRect(hwnd)
	if !ok {
		return 0, 0
	}
	var p winPoint
	if ok, _, _ := procGetCursorPos.Call(uintptr(unsafe.Pointer(&p))); ok == 0 {
		return 0, 0
	}
	cx := float64(r.left+r.right) / 2
	cy := float64(r.top+r.bottom) / 2
	long := math.Max(float64(r.right-r.left), float64(r.bottom-r.top))
	reach := math.Max(1, long/2*gazeReach)
	return softZone((float64(p.x) - cx) / reach), softZone((cy - float64(p.y)) / reach)
}

// softZone 把 -1..1 掰成「中间不动、边上照样满格」的一条折线。
func softZone(v float64) float64 {
	v = clampUnit(v)
	if math.Abs(v) <= gazeDead {
		return 0
	}
	return math.Copysign((math.Abs(v)-gazeDead)/(1-gazeDead), v)
}

func clampUnit(v float64) float64 {
	return math.Max(-1, math.Min(1, v))
}

// 上一次退出时存下来的高度比这个还矮，就当那份状态坏了——最小化/还原的过程中
// mygo 会把窗口按最小尺寸（520×480）记进 window-state.json，之后再启动就一直是
// 那个尺寸，字幕条和输入条挤成一坨。
const minRestoredHeight = 700

// defaultWindowHeight 与 main.go 里 WindowOptions.Height 保持一致。
const defaultWindowHeight = 840

// workArea 是主屏的工作区（屏幕去掉任务栏），单位是物理像素。
func workArea() (winRect, bool) {
	var r winRect
	if ok, _, _ := procSystemParams.Call(spiGetWorkArea, 0, uintptr(unsafe.Pointer(&r)), 0); ok == 0 {
		return r, false
	}
	if r.right <= r.left || r.bottom <= r.top {
		return r, false
	}
	return r, true
}

// ensureRestoredGeometry 在窗口建好之后跑一次：把「太矮」的恢复尺寸拉回默认高度，
// 再顺手把整窗夹回屏幕内（上次是被拖着退出的也得回来）。
func ensureRestoredGeometry(hwnd uintptr) {
	if hwnd == 0 {
		return
	}
	r, ok := windowRect(hwnd)
	if !ok {
		return
	}
	scale := windowScale(hwnd)
	if float64(r.bottom-r.top)/scale < minRestoredHeight {
		procSetWindowPos.Call(
			hwnd,
			0,
			uintptr(r.left),
			uintptr(r.top),
			uintptr(r.right-r.left),
			uintptr(int32(math.Round(defaultWindowHeight*scale))),
			swpNoZOrder|swpNoActivate,
		)
	}
	moveByWindow(hwnd, 0, 0)
	// 竖着装得下就别让她半截出屏：输入条在窗子最底下，被切掉一截就点不到了。
	last, ok := windowRect(hwnd)
	wa, wok := workArea()
	if !ok || !wok || last.bottom <= wa.bottom || (last.bottom-last.top) > (wa.bottom-wa.top) {
		return
	}
	procSetWindowPos.Call(
		hwnd,
		0,
		uintptr(last.left),
		uintptr(int32(wa.bottom-(last.bottom-last.top))),
		uintptr(last.right-last.left),
		uintptr(last.bottom-last.top),
		swpNoZOrder|swpNoActivate,
	)
}
