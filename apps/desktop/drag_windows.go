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
	hx := float64(r.right-r.left) / 2
	hy := float64(r.bottom-r.top) / 2
	return clampUnit((float64(p.x) - cx) / hx), clampUnit((cy - float64(p.y)) / hy)
}

func clampUnit(v float64) float64 {
	return math.Max(-1, math.Min(1, v))
}
