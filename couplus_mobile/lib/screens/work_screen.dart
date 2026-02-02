import 'dart:async';

import 'package:couplus_mobile/api/api_client.dart';
import 'package:couplus_mobile/ui/widgets.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

class WorkScreen extends StatefulWidget {
  const WorkScreen({super.key, required this.api});

  final ApiClient api;

  @override
  State<WorkScreen> createState() => _WorkScreenState();
}

class _WorkScreenState extends State<WorkScreen> {
  final _url = TextEditingController();
  final _dateFrom = TextEditingController();
  final _dateTo = TextEditingController();

  bool _loading = false;
  String? _error;
  bool _loginRequired = false;

  Map<String, dynamic>? _dashboard;

  Map<String, dynamic>? _preview;
  Map<String, dynamic>? _uploadResult;

  Map<String, dynamic>? _ordersExportResult;
  Map<String, dynamic>? _ordersUploadResult;

  Map<String, dynamic>? _purchaseDraftResult;
  Map<String, dynamic>? _purchaseUploadResult;

  @override
  void initState() {
    super.initState();

    final now = DateTime.now();
    final from = now.subtract(const Duration(days: 7));
    _dateFrom.text = _fmtDate(from);
    _dateTo.text = _fmtDate(now);

    _refresh();
  }

  @override
  void dispose() {
    _url.dispose();
    _dateFrom.dispose();
    _dateTo.dispose();
    super.dispose();
  }

  String _fmtDate(DateTime d) {
    final mm = d.month.toString().padLeft(2, '0');
    final dd = d.day.toString().padLeft(2, '0');
    return '${d.year}-$mm-$dd';
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final dash = await widget.api.getJson('/api/dashboard', query: {
        'previewLimit': '50',
        'purchaseLimit': '50',
      });

      setState(() {
        _dashboard = dash;
        _loginRequired = (dash['auth'] as Map?)?['authenticated'] != true;
      });
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _previewFromUrl() async {
    final u = _url.text.trim();
    if (u.isEmpty) {
      setState(() => _error = 'URL을 입력하세요.');
      return;
    }

    setState(() {
      _loading = true;
      _error = null;
      _preview = null;
      _uploadResult = null;
    });

    try {
      final json = await widget.api.postJson('/api/upload/preview', {'url': u});
      setState(() {
        _preview = (json['preview'] as Map?)?.cast<String, dynamic>();
        _loginRequired = false;
      });
      unawaited(_refresh());
    } catch (e) {
      if (e is ApiException && e.isUnauthorized) {
        setState(() {
          _loginRequired = true;
          _error = null;
        });
      } else {
        setState(() => _error = e.toString());
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _executeUpload() async {
    final u = _url.text.trim();
    if (u.isEmpty) {
      setState(() => _error = 'URL을 입력하세요.');
      return;
    }

    setState(() {
      _loading = true;
      _error = null;
      _uploadResult = null;
    });

    try {
      final json = await widget.api.postJson('/api/upload/execute', {'url': u});
      setState(() {
        _uploadResult = (json['result'] as Map?)?.cast<String, dynamic>();
        _loginRequired = false;
      });
      unawaited(_refresh());
    } catch (e) {
      if (e is ApiException && e.isUnauthorized) {
        setState(() {
          _loginRequired = true;
          _error = null;
        });
      } else {
        setState(() => _error = e.toString());
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _ordersExport() async {
    setState(() {
      _loading = true;
      _error = null;
      _ordersExportResult = null;
    });

    try {
      final json = await widget.api.postJson('/api/orders/export', {
        'dateFrom': _dateFrom.text.trim(),
        'dateTo': _dateTo.text.trim(),
      });
      setState(() {
        _ordersExportResult = (json['result'] as Map?)?.cast<String, dynamic>();
        _loginRequired = false;
      });
    } catch (e) {
      if (e is ApiException && e.isUnauthorized) {
        setState(() {
          _loginRequired = true;
          _error = null;
        });
      } else {
        setState(() => _error = e.toString());
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _ordersUpload() async {
    final filePath = (_ordersExportResult?['filePath'] ?? '').toString().trim();
    if (filePath.isEmpty) {
      setState(() => _error = '먼저 주문 엑셀을 생성하세요.');
      return;
    }

    setState(() {
      _loading = true;
      _error = null;
      _ordersUploadResult = null;
    });

    try {
      final json = await widget.api.postJson('/api/orders/upload', {
        'filePath': filePath,
      });
      setState(() {
        _ordersUploadResult = (json['result'] as Map?)?.cast<String, dynamic>();
        _loginRequired = false;
      });
    } catch (e) {
      if (e is ApiException && e.isUnauthorized) {
        setState(() {
          _loginRequired = true;
          _error = null;
        });
      } else {
        setState(() => _error = e.toString());
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _purchaseDraft() async {
    setState(() {
      _loading = true;
      _error = null;
      _purchaseDraftResult = null;
      _purchaseUploadResult = null;
    });

    try {
      final json = await widget.api.postJson('/api/purchase/draft', {
        'limit': 200,
      });
      setState(() {
        _purchaseDraftResult = (json['draft'] as Map?)?.cast<String, dynamic>();
        _loginRequired = false;
      });
      unawaited(_refresh());
    } catch (e) {
      if (e is ApiException && e.isUnauthorized) {
        setState(() {
          _loginRequired = true;
          _error = null;
        });
      } else {
        setState(() => _error = e.toString());
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _purchaseUpload() async {
    setState(() {
      _loading = true;
      _error = null;
      _purchaseUploadResult = null;
    });

    try {
      final json = await widget.api.postJson('/api/purchase/upload', {
        'vendors': ['domeme', 'domeggook'],
      });
      setState(() {
        _purchaseUploadResult = (json as Map).cast<String, dynamic>();
        _loginRequired = false;
      });
      unawaited(_refresh());
    } catch (e) {
      if (e is ApiException && e.isUnauthorized) {
        setState(() {
          _loginRequired = true;
          _error = null;
        });
      } else {
        setState(() => _error = e.toString());
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _openExternal(String url) async {
    final u = url.trim();
    if (!u.startsWith('http')) return;

    final uri = Uri.parse(u);
    await launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  @override
  Widget build(BuildContext context) {
    final dash = _dashboard;
    final auth = (dash?['auth'] as Map?) ?? {};
    final isAuthed = auth['authenticated'] == true && !_loginRequired;

    final previewHistory = (dash?['previewHistory'] as List?) ?? const [];
    final purchaseLogs = (dash?['purchaseLogs'] as List?) ?? const [];
    final payUrls = (dash?['payUrls'] as Map?) ?? {};

    final preview = _preview;
    final previewDraft = (preview?['draft'] as Map?) ?? {};
    final previewComputed = (preview?['computed'] as Map?) ?? {};

    final previewTitle = (previewDraft['title'] ?? '').toString();
    final previewImage = (previewDraft['imageUrl'] ?? '').toString();
    final previewFinalPrice = previewComputed['finalPrice'];
    final previewOptions = (preview?['options'] as List?) ?? const [];

    return AppScaffold(
      title: 'Work',
      onRefresh: _refresh,
      actions: [
        IconButton(
          onPressed: _loading ? null : _refresh,
          icon: const Icon(Icons.refresh),
        ),
      ],
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (_loading) const LinearProgressIndicator(minHeight: 2),
          if (_error != null) ...[
            const SizedBox(height: 12),
            ErrorBanner(message: _error!, onRetry: _refresh),
          ],
          if (!isAuthed) ...[
            const SizedBox(height: 12),
            AppCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const SectionHeader('Login required'),
                  const SizedBox(height: 10),
                  Text(
                    'Work 탭은 로그인 후 사용할 수 있어요. More 탭에서 로그인해 주세요.',
                    style: TextStyle(color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.65)),
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeader('URL → Preview / Upload'),
                const SizedBox(height: 10),
                TextField(
                  controller: _url,
                  enabled: isAuthed && !_loading,
                  decoration: const InputDecoration(
                    labelText: 'Product URL (domeme / domeggook)',
                    hintText: 'https://domeme.domeggook.com/...',
                  ),
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: (!isAuthed || _loading) ? null : _previewFromUrl,
                        child: const Text('Preview'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: FilledButton(
                        onPressed: (!isAuthed || _loading) ? null : _executeUpload,
                        child: const Text('Run upload'),
                      ),
                    ),
                  ],
                ),
                if (preview != null) ...[
                  const Divider(height: 28),
                  Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      _Thumb(url: previewImage),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              previewTitle.isEmpty ? '(no title)' : previewTitle,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontWeight: FontWeight.w900),
                            ),
                            const SizedBox(height: 6),
                            Text(
                              'finalPrice: ${previewFinalPrice ?? '-'} · options: ${previewOptions.length}',
                              style: TextStyle(
                                fontSize: 12,
                                color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.65),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ],
                if (_uploadResult != null) ...[
                  const Divider(height: 28),
                  KvRow(k: 'Upload OK', v: (_uploadResult?['ok'] == true) ? 'Yes' : 'No'),
                  KvRow(k: 'SellerProductId', v: (_uploadResult?['create'] as Map?)?['sellerProductId']?.toString() ?? '-'),
                  if ((_uploadResult?['error'] ?? '').toString().isNotEmpty)
                    KvRow(k: 'Error', v: (_uploadResult?['error'] ?? '').toString()),
                ],
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeader('Orders (Coupang → Domeme excel)'),
                const SizedBox(height: 10),
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _dateFrom,
                        enabled: isAuthed && !_loading,
                        decoration: const InputDecoration(labelText: 'dateFrom (YYYY-MM-DD)'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: TextField(
                        controller: _dateTo,
                        enabled: isAuthed && !_loading,
                        decoration: const InputDecoration(labelText: 'dateTo (YYYY-MM-DD)'),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: (!isAuthed || _loading) ? null : _ordersExport,
                        child: const Text('Generate excel'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: FilledButton(
                        onPressed: (!isAuthed || _loading) ? null : _ordersUpload,
                        child: const Text('Upload to Domeme'),
                      ),
                    ),
                  ],
                ),
                if (_ordersExportResult != null) ...[
                  const Divider(height: 28),
                  KvRow(k: 'filePath', v: (_ordersExportResult?['filePath'] ?? '-').toString()),
                  KvRow(k: 'ok', v: (_ordersExportResult?['ok'] == true) ? 'Yes' : 'No'),
                ],
                if (_ordersUploadResult != null) ...[
                  const Divider(height: 28),
                  KvRow(k: 'upload ok', v: (_ordersUploadResult?['ok'] == true) ? 'Yes' : 'No'),
                  if ((_ordersUploadResult?['error'] ?? '').toString().isNotEmpty)
                    KvRow(k: 'error', v: (_ordersUploadResult?['error'] ?? '').toString()),
                ],
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeader('Vendor purchase (paid → vendor upload)'),
                const SizedBox(height: 10),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: (!isAuthed || _loading) ? null : _purchaseDraft,
                        child: const Text('Build drafts'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: FilledButton(
                        onPressed: (!isAuthed || _loading) ? null : _purchaseUpload,
                        child: const Text('Upload to vendors'),
                      ),
                    ),
                  ],
                ),
                if (_purchaseDraftResult != null) ...[
                  const Divider(height: 28),
                  KvRow(k: 'paidOrderCount', v: (_purchaseDraftResult?['paidOrderCount'] ?? '-').toString()),
                ],
                if (_purchaseUploadResult != null) ...[
                  const Divider(height: 28),
                  Text(
                    'Upload results',
                    style: TextStyle(fontWeight: FontWeight.w900, color: Theme.of(context).colorScheme.onSurface),
                  ),
                  const SizedBox(height: 8),
                  ...(((
                    _purchaseUploadResult?['results'] as List?
                  ) ?? const [])).map((it) {
                    final row = (it as Map?) ?? {};
                    final vendor = (row['vendor'] ?? '').toString();
                    final ok = row['ok'] == true;
                    final payUrl = (row['payUrl'] ?? '').toString();
                    return Padding(
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      child: Row(
                        children: [
                          InfoChip(
                            label: vendor.isEmpty ? '-' : vendor,
                            color: ok ? const Color(0xFF2F9E44) : const Color(0xFFE03131),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Text(
                              ok ? 'OK' : (row['error'] ?? 'failed').toString(),
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          if (payUrl.startsWith('http'))
                            TextButton.icon(
                              onPressed: () => _openExternal(payUrl),
                              icon: const Icon(Icons.open_in_new, size: 18),
                              label: const Text('Pay'),
                            ),
                        ],
                      ),
                    );
                  }),
                ],
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeader('Pay URLs (latest by vendor)'),
                const SizedBox(height: 10),
                if (!isAuthed)
                  Text(
                    '로그인 후 확인할 수 있어요.',
                    style: TextStyle(color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.65)),
                  )
                else if (payUrls.isEmpty)
                  Text(
                    '아직 결제 URL이 없어요.',
                    style: TextStyle(color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.65)),
                  )
                else
                  ...payUrls.entries.map((e) {
                    final vendor = e.key.toString();
                    final url = e.value.toString();
                    return Padding(
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      child: Row(
                        children: [
                          Expanded(child: Text(vendor, style: const TextStyle(fontWeight: FontWeight.w800))),
                          TextButton.icon(
                            onPressed: () => _openExternal(url),
                            icon: const Icon(Icons.open_in_new, size: 18),
                            label: const Text('Open'),
                          ),
                        ],
                      ),
                    );
                  }),
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SectionHeader('Recent previews', trailing: InfoChip(label: '${previewHistory.length}')),
                const SizedBox(height: 10),
                if (!isAuthed)
                  Text(
                    '로그인 후 확인할 수 있어요.',
                    style: TextStyle(color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.65)),
                  )
                else if (previewHistory.isEmpty)
                  Text(
                    '아직 히스토리가 없어요. Preview를 실행한 뒤 다시 확인해보세요.',
                    style: TextStyle(color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.65)),
                  )
                else
                  ListView.separated(
                    shrinkWrap: true,
                    physics: const NeverScrollableScrollPhysics(),
                    itemCount: previewHistory.length,
                    separatorBuilder: (_, __) => const Divider(height: 18),
                    itemBuilder: (context, i) {
                      final item = previewHistory[i] as Map? ?? {};
                      final title = (item['title'] ?? '').toString();
                      final url = (item['url'] ?? '').toString();
                      final finalPrice = item['finalPrice'];
                      final imageUrl = (item['imageUrl'] ?? '').toString();

                      return Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          _Thumb(url: imageUrl),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  title.isEmpty ? '(no title)' : title,
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(fontWeight: FontWeight.w800),
                                ),
                                const SizedBox(height: 6),
                                Text(
                                  url,
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(fontSize: 12, color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.60)),
                                ),
                              ],
                            ),
                          ),
                          const SizedBox(width: 10),
                          Text(
                            finalPrice == null ? '-' : finalPrice.toString(),
                            style: const TextStyle(fontWeight: FontWeight.w900),
                          ),
                        ],
                      );
                    },
                  ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SectionHeader('Recent purchase logs', trailing: InfoChip(label: '${purchaseLogs.length}')),
                const SizedBox(height: 10),
                if (!isAuthed)
                  Text(
                    '로그인 후 확인할 수 있어요.',
                    style: TextStyle(color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.65)),
                  )
                else if (purchaseLogs.isEmpty)
                  Text(
                    '아직 로그가 없어요.',
                    style: TextStyle(color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.65)),
                  )
                else
                  ListView.separated(
                    shrinkWrap: true,
                    physics: const NeverScrollableScrollPhysics(),
                    itemCount: purchaseLogs.length,
                    separatorBuilder: (_, __) => const Divider(height: 18),
                    itemBuilder: (context, i) {
                      final it = purchaseLogs[i] as Map? ?? {};
                      final at = (it['at'] ?? '').toString();
                      final type = (it['type'] ?? '').toString();
                      final vendor = (it['vendor'] ?? '').toString();
                      final ok = it['ok'] == true;
                      final payUrl = (it['payUrl'] ?? '').toString();

                      return Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          InfoChip(
                            label: ok ? 'OK' : 'FAIL',
                            color: ok ? const Color(0xFF2F9E44) : const Color(0xFFE03131),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text('$type · $vendor', style: const TextStyle(fontWeight: FontWeight.w900)),
                                const SizedBox(height: 6),
                                Text(
                                  at,
                                  style: TextStyle(fontSize: 12, color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.60)),
                                ),
                                if ((it['error'] ?? '').toString().isNotEmpty)
                                  Padding(
                                    padding: const EdgeInsets.only(top: 6),
                                    child: Text(
                                      (it['error'] ?? '').toString(),
                                      style: TextStyle(fontSize: 12, color: Theme.of(context).colorScheme.error),
                                    ),
                                  ),
                              ],
                            ),
                          ),
                          if (payUrl.startsWith('http'))
                            TextButton.icon(
                              onPressed: () => _openExternal(payUrl),
                              icon: const Icon(Icons.open_in_new, size: 18),
                              label: const Text('Pay'),
                            ),
                        ],
                      );
                    },
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Thumb extends StatelessWidget {
  const _Thumb({required this.url});

  final String url;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final border = BorderRadius.circular(14);

    if (!url.startsWith('http')) {
      return Container(
        width: 48,
        height: 48,
        decoration: BoxDecoration(
          color: cs.primary.withValues(alpha: 0.08),
          borderRadius: border,
        ),
        child: Icon(Icons.image_outlined, color: cs.primary.withValues(alpha: 0.65)),
      );
    }

    return ClipRRect(
      borderRadius: border,
      child: Image.network(
        url,
        width: 48,
        height: 48,
        fit: BoxFit.cover,
        errorBuilder: (_, __, ___) => Container(
          width: 48,
          height: 48,
          color: cs.primary.withValues(alpha: 0.08),
          child: Icon(Icons.broken_image_outlined, color: cs.primary.withValues(alpha: 0.65)),
        ),
      ),
    );
  }
}
