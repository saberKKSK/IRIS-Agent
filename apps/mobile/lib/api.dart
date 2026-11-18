/// 跟 apps/server 说话的那条线（ADR-0048）。只用 dart:io，不引 http 包。
library;

import 'dart:convert';
import 'dart:io';

/// 服务端回的错误码（bad_code / quota / busy …）；连不上是 network，这一轮模型失败是 upstream。
class ApiError implements Exception {
  ApiError(this.code, [this.message]);

  final String code;

  /// 服务端给的现成人话（坏卡的理由、上游报错原文），没有就按 code 查表。
  final String? message;
}

class Api {
  Api(String base) : _base = Uri.parse(base);

  final Uri _base;
  final HttpClient _client = HttpClient()
    ..connectionTimeout = const Duration(seconds: 10);

  /// 登录后拿到的 token，每个请求都带在 Authorization 里。
  String? token;

  /// token 失效（过期、在别处登出）时叫一声，让界面回到登录页。
  void Function()? onUnauthorized;

  Future<HttpClientResponse> _send(
    String method,
    String path, [
    Map<String, Object?>? body,
  ]) async {
    try {
      final request = await _client.openUrl(method, _base.resolve(path));
      final bearer = token;
      if (bearer != null) {
        request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $bearer');
      }
      if (body != null) {
        request.headers.contentType = ContentType.json;
        request.add(utf8.encode(jsonEncode(body)));
      }
      return await request.close();
    } on IOException {
      throw ApiError('network');
    }
  }

  /// 把一个失败的响应翻成 ApiError。
  Future<ApiError> _failure(HttpClientResponse response) async {
    var data = <String, dynamic>{};
    try {
      final text = await utf8.decoder.bind(response).join();
      if (text.isNotEmpty) data = jsonDecode(text) as Map<String, dynamic>;
    } on FormatException {
      // 中间的代理回了一页 HTML：没有错误码可读，按状态码报。
    } on IOException {
      return ApiError('network');
    }
    final code = data['error'] as String? ?? 'http_${response.statusCode}';
    if (code == 'unauthorized') onUnauthorized?.call();
    return ApiError(code, data['message'] as String?);
  }

  Future<Map<String, dynamic>> _json(
    String method,
    String path, [
    Map<String, Object?>? body,
  ]) async {
    final response = await _send(method, path, body);
    if (response.statusCode >= 400) throw await _failure(response);
    try {
      final text = await utf8.decoder.bind(response).join();
      if (text.isEmpty) return <String, dynamic>{};
      return jsonDecode(text) as Map<String, dynamic>;
    } on IOException {
      throw ApiError('network');
    }
  }

  Future<void> sendCode(String phone) =>
      _json('POST', '/auth/code', {'phone': phone});

  /// 验码登录，返回 token（调用方负责存起来）。
  Future<String> login(String phone, String code) async {
    final data = await _json('POST', '/auth/login', {
      'phone': phone,
      'code': code,
    });
    return data['token'] as String;
  }

  Future<void> logout() => _json('POST', '/auth/logout');

  /// 账号状态：脱敏手机号、人设卡（没建就是 null）、key 末四位、今日额度。
  Future<Map<String, dynamic>> me() => _json('GET', '/me');

  Future<void> saveCard(Map<String, Object?> card) =>
      _json('PUT', '/card', card);

  Future<void> saveKey(String key) => _json('PUT', '/key', {'key': key});

  Future<void> dropKey() => _json('DELETE', '/key');

  /// 一页历史（最多 50 条，旧→新）。before 给上一页最旧那条的 id。
  Future<List<Map<String, dynamic>>> history({int? before}) async {
    final data = await _json(
      'GET',
      before == null ? '/history' : '/history?before=$before',
    );
    return (data['messages'] as List<dynamic>).cast<Map<String, dynamic>>();
  }

  /// 说一句。流里依次是 {type: delta, text} …，最后一条 {type: turn, text}
  /// 或 {type: error, message}。
  Stream<Map<String, dynamic>> say(String text) async* {
    final response = await _send('POST', '/say', {'text': text});
    if (response.statusCode != 200) throw await _failure(response);
    var buffer = '';
    try {
      await for (final chunk in utf8.decoder.bind(response)) {
        buffer += chunk;
        var cut = buffer.indexOf('\n\n');
        while (cut >= 0) {
          final frame = buffer.substring(0, cut);
          buffer = buffer.substring(cut + 2);
          // 心跳是 ": ping" 开头的注释行，跳过。
          if (frame.startsWith('data: ')) {
            yield jsonDecode(frame.substring(6)) as Map<String, dynamic>;
          }
          cut = buffer.indexOf('\n\n');
        }
      }
    } on IOException {
      throw ApiError('network');
    }
  }
}
