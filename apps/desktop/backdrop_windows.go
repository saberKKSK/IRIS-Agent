//go:build windows

package main

import (
	"syscall"
	"unsafe"
)

// DWMWA_SYSTEMBACKDROP_TYPE and its DWMSBT_NONE, from dwmapi.h.
const (
	dwmwaSystemBackdropType = 38
	dwmsbtNone              = 1
)

// disableSystemBackdrop takes the window out of the system backdrop.
//
// Windows 11 24H2 (build 26200 here) gives a window that has no redirection
// bitmap and draws through DirectComposition — what a transparent MyGo window
// is — the acrylic material by default: the desktop behind arrives blurred and
// lifted instead of showing through, and a window made layered on top of that
// turns into a flat light grey. MyGo never sets the attribute, so the system
// chooses; nothing but this call told Windows otherwise.
func disableSystemBackdrop(hwnd uintptr) {
	if hwnd == 0 {
		return
	}
	dwmapi := syscall.NewLazyDLL("dwmapi.dll")
	setAttribute := dwmapi.NewProc("DwmSetWindowAttribute")
	extendFrame := dwmapi.NewProc("DwmExtendFrameIntoClientArea")

	none := int32(dwmsbtNone)
	setAttribute.Call(hwnd, dwmwaSystemBackdropType, uintptr(unsafe.Pointer(&none)), unsafe.Sizeof(none))

	// No frame either, so that no material has anywhere to show even if the
	// attribute comes back.
	var margins struct{ left, right, top, bottom int32 }
	extendFrame.Call(hwnd, uintptr(unsafe.Pointer(&margins)))
}
