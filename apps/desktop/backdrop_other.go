//go:build !windows

package main

// disableSystemBackdrop is a no-op where there is no system backdrop to turn
// off: macOS vibrancy is only what an app asks for.
func disableSystemBackdrop(uintptr) {}
