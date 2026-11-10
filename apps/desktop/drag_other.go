//go:build !windows

package main

// moveByWindow and cursorGaze are Windows-only for now; elsewhere the page
// keeps the pointer it sees.
func moveByWindow(uintptr, float64, float64) {}

func cursorGaze(uintptr) (float64, float64) { return 0, 0 }
