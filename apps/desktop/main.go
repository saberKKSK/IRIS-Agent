// Command desktop is IRIS's shell: a frameless, always-on-top window that
// shows 大肥鱼, her words, and a line to answer her.
//
// It is a MyGo app — Go owns the window (transparency, click-through, the
// model's files over a custom scheme) and the page is plain web: Pixi 8 +
// Live2D. The brain is not here: server/daemon.mjs (Node, iris-core) runs
// beside it and the page talks to it over HTTP — SSE for the stream, fetch
// to speak. The shell starts it when it is not already up.
package main

import (
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/ui"
)

const (
	appName     = "伊里斯"
	appVersion  = "0.1.0"
	daemonPort  = 5274
	modelScheme = "live2d"
)

// Rect is a clickable area of the window, in DIPs from its top-left corner.
type Rect struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

// Env is where the page finds her brain and her model.
type Env struct {
	APIBase   string `json:"apiBase"`
	ModelBase string `json:"modelBase"`
	Platform  string `json:"platform"`
	Version   string `json:"version"`
	Hosted    bool   `json:"hosted"`
}

// Shell is the Go half of the page. mygo generate turns its methods into
// typed TypeScript in src/mygo.ts.
type Shell struct {
	mu     sync.Mutex
	win    *mygo.Window
	page   *mygo.WebView
	env    Env
	region []mygo.Rectangle
}

// view is the window's native UI: her page, filling it, and nothing else.
//
// The window shows native UI because that is what makes it per-pixel
// transparent on Windows: a window whose whole content is a page keeps its
// redirection bitmap, which is opaque, so the desktop never shows through.
// Native UI composes through DirectComposition, and the web view's frames
// over it carry alpha.
func (s *Shell) view(c *ui.Context) {
	c.Root().Background(ui.Transparent)
	if page := s.page; page != nil {
		ui.WebView(c, page).Grow(1)
	}
}

// Env returns where the page finds the daemon and the model.
func (s *Shell) Env() Env { return s.env }

// SetInputRegion limits the part of the window that takes the mouse to
// rects: presses anywhere else go through to the desktop behind her, as if
// the window were not there. The page sends it whenever the layout moves.
func (s *Shell) SetInputRegion(rects []Rect) {
	// A nil region keeps the window out of layered mode (mygo makes a
	// window with an input region layered, and a layered window cannot
	// draw WebView2 or DirectComposition content through its clear pixels),
	// so an empty region means the whole window takes the mouse.
	var out []mygo.Rectangle
	for _, r := range rects {
		if r.Width <= 0 || r.Height <= 0 {
			continue
		}
		out = append(out, mygo.Rectangle{X: r.X, Y: r.Y, Width: r.Width, Height: r.Height})
	}
	s.mu.Lock()
	changed := !sameRegion(s.region, out)
	if changed {
		s.region = out
	}
	win := s.win
	s.mu.Unlock()
	if changed && win != nil {
		win.SetInputRegion(out)
	}
}

// MoveBy moves the window by dx, dy DIPs, while the page drags it anywhere
// that is not the composer.
//
// The page does the dragging itself: MyGo's StartDrag asks Windows to run
// a caption move loop, which the moves it waits for never reach — the
// WebView2 child window holds the mouse capture — so the window stayed
// where it was. The page has the capture, so it sends the deltas. The strip
// that stays on screen is enforced here too, so she cannot be dropped off
// the edge of the desktop.
func (s *Shell) MoveBy(dx, dy float64) {
	if dx == 0 && dy == 0 {
		return
	}
	s.mu.Lock()
	win := s.win
	s.mu.Unlock()
	if win == nil {
		return
	}
	moveByWindow(win.NativeHandle(), dx, dy)
}

// Gaze is where the mouse is relative to the window: -1..1, the window's
// centre at 0, positive x to the right, positive y up.
type Gaze struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// Gaze returns where the cursor is relative to the window's centre.
//
// She should look at the mouse wherever it is, so the page asks for this a
// few times a second instead of listening for pointer moves: most of the
// window is click-through, and over that part the pointer never reaches the
// page at all — her head would stay where it was the last time he crossed
// her, which is what "她一直抬着头" was.
func (s *Shell) Gaze() Gaze {
	s.mu.Lock()
	win := s.win
	s.mu.Unlock()
	if win == nil {
		return Gaze{}
	}
	x, y := cursorGaze(win.NativeHandle())
	return Gaze{X: x, Y: y}
}

// InputRegion returns the rects the page last sent, for tests and for
// screenshots of the shell.
func (s *Shell) InputRegion() []Rect {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Rect, 0, len(s.region))
	for _, r := range s.region {
		out = append(out, Rect{X: r.X, Y: r.Y, Width: r.Width, Height: r.Height})
	}
	return out
}

func sameRegion(a, b []mygo.Rectangle) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func main() {
	setupLog()
	shell := &Shell{env: Env{
		APIBase:   fmt.Sprintf("http://127.0.0.1:%d", daemonPort),
		ModelBase: fmt.Sprintf("http://127.0.0.1:%d/live2d", daemonPort),
		Platform:  runtime.GOOS + "/" + runtime.GOARCH,
		Version:   appVersion,
		Hosted:    true,
	}}

	if dir := resolveModelDir(); dir != "" {
		// The model's files are outside the frontend (its license forbids
		// redistributing them), so they are served from a scheme of their
		// own: live2d://localhost/… — http://live2d.localhost/… on Windows.
		if err := mygo.Protocol.Handle(modelScheme, mygo.FileServer(os.DirFS(dir))); err != nil {
			log.Printf("[shell] 自定义协议 %s 没注册上：%v（退回 daemon 的 /live2d）", modelScheme, err)
		} else {
			shell.env.ModelBase = schemeBase(modelScheme)
			log.Printf("[shell] 模型 %s ← %s", shell.env.ModelBase, dir)
		}
	} else {
		log.Printf("[shell] 找不到模型目录，退回 daemon 的 /live2d")
	}

	mygo.Bind(shell)

	daemon := ensureDaemon()
	stop := func() {
		if daemon != nil && daemon.Process != nil {
			_ = daemon.Process.Kill()
			_, _ = daemon.Process.Wait()
		}
	}
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
		<-sig
		stop()
		os.Exit(0)
	}()

	mygo.App.WhenReady(func() {
		win := mygo.NewWindow(mygo.WindowOptions{
			Title:         appName,
			Width:         520,
			Height:        840,
			MinWidth:      320,
			MinHeight:     480,
			Frameless:     true,
			Transparent:   true,
			AlwaysOnTop:   true,
			SkipTaskbar:   true,
			DisableShadow: true, // 影子会把整个 520×840 的框描出来
			StateKey:      "iris-shell",
			Content:       ui.View(shell.view),
		})
		// Windows 11 24H2 起，没有重定向位图、靠 DirectComposition 画的窗口会被
		// 系统默认套一层亚克力（桌面透过来是模糊+提亮的，不是原样），必须关掉。
		disableSystemBackdrop(win.NativeHandle())
		// 上次要是被拖到屏幕外退出的，开机先把她拽回来。
		moveByWindow(win.NativeHandle(), 0, 0)
		page, err := win.NewWebView(mygo.WebViewOptions{URL: "/", Transparent: true, BackgroundColor: "#00000000"})
		if err != nil {
			log.Printf("[shell] 页面没建起来：%v", err)
		}
		shell.mu.Lock()
		shell.win = win
		shell.page = page
		region := shell.region
		shell.mu.Unlock()
		disableSystemBackdrop(win.NativeHandle())
		win.Invalidate()
		if len(region) > 0 {
			win.SetInputRegion(region)
		}
		win.OnClose(func(e *mygo.CloseEvent) { stop() })
		// 最小化再恢复时，WebView2 那层不会自己回到合成树上：窗口回来是空的，
		// 连字幕条和输入框一起不见（native UI 那层是透明的，所以整窗像什么都没有）。
		// 恢复、重新显示时补一次重画。
		win.OnRestore(func() { win.Invalidate() })
		win.OnShow(func() { win.Invalidate() })
	})

	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
	stop()
}

// schemeBase is the URL a custom scheme is served at, per platform.
func schemeBase(scheme string) string {
	if runtime.GOOS == "windows" {
		// WebView2 serves custom schemes under <scheme>.localhost.
		return "http://" + scheme + ".localhost"
	}
	return scheme + "://localhost"
}

// resolveModelDir finds the Live2D model: IRIS_LIVE2D_DIR, else
// assets/live2d/大肥鱼/DeepSeek up from the executable or the working directory.
func resolveModelDir() string {
	if v := strings.TrimSpace(os.Getenv("IRIS_LIVE2D_DIR")); v != "" {
		if isDir(v) {
			return v
		}
		log.Printf("[shell] IRIS_LIVE2D_DIR=%s 不是目录，忽略", v)
	}
	rel := filepath.Join("assets", "live2d", "大肥鱼", "DeepSeek")
	seeds := []string{}
	if exe, err := os.Executable(); err == nil {
		seeds = append(seeds, filepath.Dir(exe))
	}
	if wd, err := os.Getwd(); err == nil {
		seeds = append(seeds, wd)
	}
	for _, seed := range seeds {
		dir := seed
		for i := 0; i < 6; i++ {
			candidate := filepath.Join(dir, rel)
			if isDir(candidate) {
				return candidate
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return ""
}

func isDir(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.IsDir()
}

// daemonPath finds server/daemon.mjs up from the executable or the working
// directory.
func daemonPath() string {
	seeds := []string{}
	if exe, err := os.Executable(); err == nil {
		seeds = append(seeds, filepath.Dir(exe))
	}
	if wd, err := os.Getwd(); err == nil {
		seeds = append(seeds, wd)
	}
	for _, seed := range seeds {
		dir := seed
		for i := 0; i < 6; i++ {
			candidate := filepath.Join(dir, "server", "daemon.mjs")
			if st, err := os.Stat(candidate); err == nil && !st.IsDir() {
				return candidate
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				break
			}
			dir = parent
		}
	}
	return ""
}

func daemonUp() bool {
	client := &http.Client{Timeout: 400 * time.Millisecond}
	res, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/health", daemonPort))
	if err != nil {
		return false
	}
	defer func() { _ = res.Body.Close() }()
	return res.StatusCode == http.StatusOK
}

// ensureDaemon starts the brain when it is not already listening, and
// waits for it to answer. It returns nil when it found one running.
func ensureDaemon() *exec.Cmd {
	if daemonUp() {
		log.Printf("[shell] daemon 已经在跑：http://127.0.0.1:%d", daemonPort)
		return nil
	}
	script := daemonPath()
	if script == "" {
		log.Printf("[shell] 找不到 server/daemon.mjs，她自己不会说话")
		return nil
	}
	node, err := exec.LookPath("node")
	if err != nil {
		log.Printf("[shell] 找不到 node，daemon 起不来：%v", err)
		return nil
	}
	cmd := exec.Command(node, script)
	cmd.Dir = filepath.Dir(script)
	cmd.Env = append(os.Environ(), fmt.Sprintf("IRIS_DESKTOP_PORT=%d", daemonPort))
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		log.Printf("[shell] daemon 起不来：%v", err)
		return nil
	}
	log.Printf("[shell] daemon 起来了（pid %d）：%s", cmd.Process.Pid, script)
	for i := 0; i < 150; i++ {
		if daemonUp() {
			return cmd
		}
		if cmd.ProcessState != nil {
			log.Printf("[shell] daemon 退出了：%v", cmd.ProcessState)
			return nil
		}
		time.Sleep(200 * time.Millisecond)
	}
	log.Printf("[shell] daemon 30 秒还没应答，先这么跑着")
	return cmd
}

var errNoDaemon = errors.New("没有 daemon")

func setupLog() {
	f, err := os.OpenFile(filepath.Join(os.TempDir(), "iris-shell.log"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	log.SetOutput(io.MultiWriter(os.Stdout, f))
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
}
