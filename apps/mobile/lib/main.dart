/// IRIS 手机端（ADR-0048）：登录、人设卡、聊天。
///
/// 服务器地址在编译时给：
///   flutter run --dart-define=IRIS_SERVER=https://你的域名
/// 不给就连 Android 模拟器里的宿主机（http://10.0.2.2:5280）。
library;

import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'api.dart';

const _server = String.fromEnvironment(
  'IRIS_SERVER',
  defaultValue: 'http://10.0.2.2:5280',
);
const _storage = FlutterSecureStorage();
const _tokenKey = 'iris_token';
const _pageSize = 50;

final api = Api(_server);

const _errors = <String, String>{
  'network': '连不上服务器',
  'bad_phone': '手机号不对',
  'bad_code': '验证码不对或过期了',
  'too_many': '发得太勤了，过一会儿再试',
  'quota': '今天的额度用完了。填上自己的 API key 可以接着聊',
  'busy': '上一句还没说完',
  'bad_key': '这个 key 看着不对',
  'bad_text': '这句太长了',
  'too_large': '内容太长了',
  'unauthorized': '登录过期了，请重新登录',
};

String errorText(ApiError error) =>
    error.message ?? _errors[error.code] ?? '出错了（${error.code}）';

void main() => runApp(const IrisApp());

class IrisApp extends StatelessWidget {
  const IrisApp({super.key});

  @override
  Widget build(BuildContext context) {
    const seed = Color(0xFFB4536B);
    return MaterialApp(
      title: 'IRIS',
      theme: ThemeData(colorSchemeSeed: seed),
      darkTheme: ThemeData(colorSchemeSeed: seed, brightness: Brightness.dark),
      home: const Root(),
    );
  }
}

/// 跑一个会失败的动作：期间 busy 为真，失败了弹一条提示。
mixin Busy<T extends StatefulWidget> on State<T> {
  bool busy = false;

  Future<void> run(Future<void> Function() action) async {
    setState(() => busy = true);
    try {
      await action();
    } on ApiError catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text(errorText(error))),
        );
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }
}

/// 按登录态决定看哪一页：登录 → 建卡 → 聊天。
class Root extends StatefulWidget {
  const Root({super.key});

  @override
  State<Root> createState() => _RootState();
}

class _RootState extends State<Root> {
  Map<String, dynamic>? _me;
  bool _loading = true;
  String? _error;

  @override
  void initState() {
    super.initState();
    api.onUnauthorized = _forget;
    _start();
  }

  Future<void> _start() async {
    api.token = await _storage.read(key: _tokenKey);
    await _refresh();
  }

  Future<void> _refresh() async {
    if (!mounted) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    Map<String, dynamic>? me;
    String? error;
    if (api.token != null) {
      try {
        me = await api.me();
      } on ApiError catch (failure) {
        // token 失效时 _forget 已经把界面切回登录页了。
        if (failure.code != 'unauthorized') error = errorText(failure);
      }
    }
    if (!mounted) return;
    setState(() {
      _me = me;
      _error = error;
      _loading = false;
    });
  }

  Future<void> _signedIn(String token) async {
    api.token = token;
    await _storage.write(key: _tokenKey, value: token);
    await _refresh();
  }

  /// 本机忘掉登录态（token 失效或主动退出）。
  void _forget() {
    api.token = null;
    _storage.delete(key: _tokenKey);
    if (mounted) setState(() => _me = null);
  }

  Future<void> _signOut() async {
    try {
      await api.logout();
    } on ApiError {
      // 服务器够不着也照样退：本机的 token 清掉就是退出了。
    }
    _forget();
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    final error = _error;
    if (error != null) {
      return Scaffold(
        body: Center(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(error),
              const SizedBox(height: 12),
              FilledButton(onPressed: _refresh, child: const Text('重试')),
            ],
          ),
        ),
      );
    }
    final me = _me;
    if (api.token == null || me == null) return LoginPage(onDone: _signedIn);
    if (me['card'] == null) {
      return SettingsPage(me: me, onChanged: _refresh, onSignOut: _signOut);
    }
    return ChatPage(me: me, onChanged: _refresh, onSignOut: _signOut);
  }
}

class LoginPage extends StatefulWidget {
  const LoginPage({super.key, required this.onDone});

  final Future<void> Function(String token) onDone;

  @override
  State<LoginPage> createState() => _LoginPageState();
}

class _LoginPageState extends State<LoginPage> with Busy<LoginPage> {
  final _phone = TextEditingController();
  final _code = TextEditingController();

  @override
  void dispose() {
    _phone.dispose();
    _code.dispose();
    super.dispose();
  }

  Future<void> _sendCode() => run(() async {
        await api.sendCode(_phone.text.trim());
        if (!mounted) return;
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('验证码发出去了')),
        );
      });

  Future<void> _login() => run(() async {
        final token = await api.login(_phone.text.trim(), _code.text.trim());
        await widget.onDone(token);
      });

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('登录')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(
            controller: _phone,
            keyboardType: TextInputType.phone,
            maxLength: 11,
            autofillHints: const [AutofillHints.telephoneNumber],
            decoration: const InputDecoration(
              labelText: '手机号',
              border: OutlineInputBorder(),
              counterText: '',
            ),
          ),
          const SizedBox(height: 12),
          OutlinedButton(
            onPressed: busy ? null : _sendCode,
            child: const Text('发验证码'),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _code,
            keyboardType: TextInputType.number,
            maxLength: 6,
            autofillHints: const [AutofillHints.oneTimeCode],
            decoration: const InputDecoration(
              labelText: '验证码',
              border: OutlineInputBorder(),
              counterText: '',
            ),
          ),
          const SizedBox(height: 12),
          FilledButton(
            onPressed: busy ? null : _login,
            child: const Text('登录'),
          ),
          const SizedBox(height: 12),
          const Text('没注册过的手机号会自动注册。'),
        ],
      ),
    );
  }
}

/// 人设卡 + 账号设置。第一次登录时它是首页（还没卡），之后从聊天页右上角进来。
class SettingsPage extends StatefulWidget {
  const SettingsPage({
    super.key,
    required this.me,
    required this.onChanged,
    required this.onSignOut,
  });

  final Map<String, dynamic> me;
  final Future<void> Function() onChanged;
  final Future<void> Function() onSignOut;

  @override
  State<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends State<SettingsPage> with Busy<SettingsPage> {
  late final Map<String, dynamic>? _card =
      widget.me['card'] as Map<String, dynamic>?;
  late final _name = TextEditingController(text: _card?['name'] as String?);
  late final _doc = TextEditingController(text: _card?['doc'] as String?);
  final _key = TextEditingController();
  late String _pronouns = _card?['pronouns'] as String? ?? '他';
  late String _userPronoun = _card?['userPronoun'] as String? ?? '她';
  late bool _stage = _card?['stageDirections'] as bool? ?? true;

  @override
  void dispose() {
    _name.dispose();
    _doc.dispose();
    _key.dispose();
    super.dispose();
  }

  /// 改完回聊天页，再让首页按新状态重画。
  Future<void> _apply(Future<void> Function() change) => run(() async {
        await change();
        if (!mounted) return;
        final navigator = Navigator.of(context);
        final refresh = widget.onChanged;
        if (navigator.canPop()) navigator.pop();
        await refresh();
      });

  Widget _choice(
    String label,
    List<String> options,
    String selected,
    ValueChanged<String> onPick,
  ) {
    return Row(
      children: [
        SizedBox(width: 64, child: Text(label)),
        SegmentedButton<String>(
          segments: [
            for (final option in options)
              ButtonSegment(value: option, label: Text(option)),
          ],
          selected: {selected},
          onSelectionChanged: (picked) => onPick(picked.first),
        ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final keyTail = widget.me['keyTail'] as String?;
    final quota = widget.me['quota'] as Map<String, dynamic>;
    return Scaffold(
      appBar: AppBar(title: const Text('人设卡')),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          TextField(
            controller: _name,
            maxLength: 20,
            decoration: const InputDecoration(
              labelText: '名字',
              border: OutlineInputBorder(),
            ),
          ),
          _choice(
            'TA 是',
            const ['他', '她', '它'],
            _pronouns,
            (value) => setState(() => _pronouns = value),
          ),
          const SizedBox(height: 8),
          _choice(
            '你是',
            const ['她', '他'],
            _userPronoun,
            (value) => setState(() => _userPronoun = value),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _doc,
            maxLength: 8000,
            minLines: 8,
            maxLines: 16,
            decoration: const InputDecoration(
              labelText: '人设正文',
              helperText: '性格、说话方式、你们的关系、怎么称呼你、不能做的事',
              helperMaxLines: 2,
              alignLabelWithHint: true,
              border: OutlineInputBorder(),
            ),
          ),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('允许用括号写动作和神情'),
            value: _stage,
            onChanged: (value) => setState(() => _stage = value),
          ),
          FilledButton(
            onPressed: busy
                ? null
                : () => _apply(
                      () => api.saveCard({
                        'name': _name.text,
                        'pronouns': _pronouns,
                        'userPronoun': _userPronoun,
                        'doc': _doc.text,
                        'stageDirections': _stage,
                      }),
                    ),
            child: const Text('保存人设卡'),
          ),
          const Divider(height: 40),
          Text(
            keyTail == null
                ? '没填 key：今天用了 ${quota['used']} / ${quota['limit']} 轮'
                : '在用你自己的 key（末尾 $keyTail）',
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _key,
            obscureText: true,
            autocorrect: false,
            enableSuggestions: false,
            decoration: const InputDecoration(
              labelText: '自己的 DeepSeek API key',
              helperText: '填了就不占每日额度',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 12),
          OutlinedButton(
            onPressed:
                busy ? null : () => _apply(() => api.saveKey(_key.text.trim())),
            child: const Text('保存 key'),
          ),
          if (keyTail != null)
            TextButton(
              onPressed: busy ? null : () => _apply(api.dropKey),
              child: const Text('删掉 key'),
            ),
          TextButton(
            onPressed: busy
                ? null
                : () {
                    final navigator = Navigator.of(context);
                    if (navigator.canPop()) navigator.pop();
                    widget.onSignOut();
                  },
            child: const Text('退出登录'),
          ),
        ],
      ),
    );
  }
}

class _Message {
  _Message(this.role, this.text);

  final String role;
  String text;
}

class ChatPage extends StatefulWidget {
  const ChatPage({
    super.key,
    required this.me,
    required this.onChanged,
    required this.onSignOut,
  });

  final Map<String, dynamic> me;
  final Future<void> Function() onChanged;
  final Future<void> Function() onSignOut;

  @override
  State<ChatPage> createState() => _ChatPageState();
}

class _ChatPageState extends State<ChatPage> with Busy<ChatPage> {
  /// 旧 → 新。
  final _messages = <_Message>[];
  final _input = TextEditingController();
  int? _oldest;
  bool _more = false;

  @override
  void initState() {
    super.initState();
    _loadOlder();
  }

  @override
  void dispose() {
    _input.dispose();
    super.dispose();
  }

  Future<void> _loadOlder() => run(() async {
        final page = await api.history(before: _oldest);
        if (!mounted) return;
        setState(() {
          _messages.insertAll(0, [
            for (final row in page)
              _Message(row['role'] as String, row['content'] as String),
          ]);
          if (page.isNotEmpty) _oldest = page.first['id'] as int;
          _more = page.length == _pageSize;
        });
      });

  Future<void> _send() => run(() async {
        final text = _input.text.trim();
        if (text.isEmpty) return;
        final mine = _Message('user', text);
        final reply = _Message('assistant', '');
        setState(() => _messages..add(mine)..add(reply));
        _input.clear();
        var started = false;
        try {
          await for (final event in api.say(text)) {
            started = true;
            if (!mounted) return;
            switch (event['type']) {
              case 'delta':
                setState(() => reply.text += event['text'] as String);
              case 'turn':
                // 收尾那条是清理过的全文，以它为准。
                setState(() => reply.text = event['text'] as String);
              case 'error':
                throw ApiError('upstream', event['message'] as String?);
            }
          }
        } on ApiError catch (error) {
          // 没说成、服务端也没存：两条都撤掉，原话放回输入框。
          // 说到一半断网不撤——服务端会照常说完存好，下次打开看得到。
          if (mounted && !(started && error.code == 'network')) {
            setState(() => _messages..remove(mine)..remove(reply));
            _input.text = text;
          }
          rethrow;
        }
      });

  void _openSettings() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => SettingsPage(
          me: widget.me,
          onChanged: widget.onChanged,
          onSignOut: widget.onSignOut,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final card = widget.me['card'] as Map<String, dynamic>;
    return Scaffold(
      appBar: AppBar(
        title: Text(card['name'] as String),
        actions: [
          IconButton(
            icon: const Icon(Icons.settings),
            tooltip: '设置',
            onPressed: _openSettings,
          ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              // reverse：最新的贴着输入框，流式追加时不用自己滚。
              child: ListView.builder(
                reverse: true,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                itemCount: _messages.length + (_more ? 1 : 0),
                itemBuilder: (context, index) {
                  if (index == _messages.length) {
                    return Center(
                      child: TextButton(
                        onPressed: busy ? null : _loadOlder,
                        child: const Text('更早的'),
                      ),
                    );
                  }
                  return _Bubble(_messages[_messages.length - 1 - index]);
                },
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 4, 12, 4),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  Expanded(
                    child: TextField(
                      controller: _input,
                      minLines: 1,
                      maxLines: 5,
                      maxLength: 4000,
                      decoration: const InputDecoration(
                        hintText: '说点什么',
                        border: OutlineInputBorder(),
                        counterText: '',
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  IconButton.filled(
                    icon: const Icon(Icons.send),
                    tooltip: '发送',
                    onPressed: busy ? null : _send,
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.only(bottom: 4),
              child: Text(
                '对面是 AI，回复由模型生成。',
                style: Theme.of(context).textTheme.labelSmall,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Bubble extends StatelessWidget {
  const _Bubble(this.message);

  final _Message message;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final mine = message.role == 'user';
    return Align(
      alignment: mine ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * 0.8,
        ),
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: mine ? scheme.primary : scheme.secondaryContainer,
          borderRadius: BorderRadius.circular(14),
        ),
        child: SelectableText(
          message.text,
          style: TextStyle(
            color: mine ? scheme.onPrimary : scheme.onSecondaryContainer,
          ),
        ),
      ),
    );
  }
}
