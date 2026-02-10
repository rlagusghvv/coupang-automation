import 'dart:async';
import 'dart:convert';

import 'package:couplus_mobile/api/api_client.dart';
import 'package:couplus_mobile/screens/preview_detail_screen.dart';
import 'package:couplus_mobile/ui/widgets.dart';
import 'package:couplus_mobile/screens/image_edit_screen.dart';
import 'package:couplus_mobile/screens/image_viewer_screen.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

class WorkScreen extends StatefulWidget {
  const WorkScreen({super.key, required this.api});

  final ApiClient api;

  @override
  State<WorkScreen> createState() => _WorkScreenState();
}

enum _QueueStatus { pending, confirmed, uploading, success, failed, skipped }

class _QueueItem {
  _QueueItem({required this.url});

  final String url;
  _QueueStatus status = _QueueStatus.pending;
  Map<String, dynamic>? preview;
  Map<String, dynamic>? uploadResult;
  String? error;
}

class _WorkScreenState extends State<WorkScreen> {
  final _url = TextEditingController();
  final _batchUrls = TextEditingController();
  // 주문 관련 날짜는 주문 탭에서 사용합니다.
  // (Work 탭은 상품 업로드 전용)
  // final _dateFrom = TextEditingController();
  // final _dateTo = TextEditingController();

  bool _loading = false;
  String? _error;
  bool _loginRequired = false;

  bool _forceUpload = false;
  bool _skipPreviewBeforeUpload = false;
  List<String>? _imagesOverride;

  // Presets
  List<Map<String, dynamic>> _presets = const [];
  String? _selectedPresetId;

  // Batch queue
  final List<_QueueItem> _queue = [];
  bool _batchRunning = false;

  Map<String, dynamic>? _dashboard;

  Map<String, dynamic>? _preview;
  Map<String, dynamic>? _uploadResult;

  // 주문 관련 상태값은 주문 탭으로 이동했습니다.
  // Map<String, dynamic>? _ordersExportResult;
  // Map<String, dynamic>? _ordersUploadResult;
  // Map<String, dynamic>? _purchaseDraftResult;
  // Map<String, dynamic>? _purchaseUploadResult;

  @override
  void initState() {
    super.initState();

    // 날짜 입력(주문 기능)은 주문 탭으로 이동했습니다.

    _refresh();
  }

  @override
  void dispose() {
    _url.dispose();
    _batchUrls.dispose();
    super.dispose();
  }

  // (주문 탭으로 이동) 날짜 포맷 함수는 더 이상 Work 탭에서 사용하지 않습니다.

  List<String> _parseUrls(String raw) {
    final text = raw.replaceAll('\r', '\n');
    final parts = text.split(RegExp(r'[\n,\s]+'));
    final out = <String>[];
    final seen = <String>{};
    for (final p in parts) {
      final u = p.trim();
      if (u.isEmpty) continue;
      if (!u.startsWith('http')) continue;
      if (seen.contains(u)) continue;
      seen.add(u);
      out.add(u);
    }
    return out;
  }

  int _enqueueFromText(String raw) {
    final urls = _parseUrls(raw);
    if (urls.isEmpty) return 0;
    final existing = _queue.map((e) => e.url).toSet();
    var added = 0;
    setState(() {
      for (final u in urls) {
        if (existing.contains(u)) continue;
        _queue.add(_QueueItem(url: u));
        added += 1;
      }
    });
    return added;
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

      final authed = (dash['auth'] as Map?)?['authenticated'] == true;
      Map<String, dynamic>? presetJson;
      if (authed) {
        try {
          presetJson =
              await widget.api.getJson('/api/presets', query: {'limit': '200'});
        } catch (_) {
          presetJson = null;
        }
      }

      final presetList = (presetJson?['presets'] as List?) ?? const [];

      setState(() {
        _dashboard = dash;
        _loginRequired = !authed;
        _presets =
            presetList.map((e) => (e as Map).cast<String, dynamic>()).toList();
        if (_selectedPresetId != null &&
            !_presets.any((p) => p['id'] == _selectedPresetId)) {
          _selectedPresetId = null;
        }
      });
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  String _humanizeJobStatus(String s) {
    switch (s) {
      case 'queued':
        return '대기중';
      case 'running':
        return '진행중';
      case 'success':
        return '완료';
      case 'failed':
        return '실패';
      default:
        return s;
    }
  }

  Map<String, dynamic>? _activeJob;
  String? _titleOverride;

  Future<void> _startJob(String kind) async {
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
      final json = await widget.api.postJson('/api/jobs/start', {
        'kind': kind,
        'url': u,
        'force': (kind == 'upload' && _forceUpload) ? '1' : '0',
        if ((_selectedPresetId ?? '').trim().isNotEmpty)
          'presetId': (_selectedPresetId ?? '').trim(),
        if (kind == 'upload' && (_titleOverride ?? '').trim().isNotEmpty)
          'titleOverride': (_titleOverride ?? '').trim(),
        if (kind == 'upload' && (_imagesOverride ?? const []).isNotEmpty)
          'imagesOverride': (_imagesOverride ?? const []),
      });
      final job = (json['job'] as Map?)?.cast<String, dynamic>();
      setState(() {
        _activeJob = job;
        _loginRequired = false;
      });

      // poll
      unawaited(_pollJob());
    } catch (e) {
      if (e is ApiException && e.isUnauthorized) {
        setState(() {
          _loginRequired = true;
          _error = null;
        });
      } else if (e is ApiException && e.statusCode == 409) {
        // duplicate_product
        try {
          final raw = e.details ?? '';
          final map = jsonDecode(raw) as Map<String, dynamic>;
          if (map['error'] == 'duplicate_product') {
            final existing = (map['existing'] as Map?)?.cast<String, dynamic>();
            if (existing != null && mounted) {
              await showDialog<void>(
                context: context,
                builder: (_) {
                  final title = (existing['title'] ?? '').toString();
                  final pid = (existing['sellerProductId'] ?? '').toString();
                  final productUrl = (existing['productUrl'] ?? '').toString();
                  return AlertDialog(
                    title: const Text('이미 등록된 상품'),
                    content: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(title.isEmpty ? '(제목 없음)' : title),
                        const SizedBox(height: 8),
                        Text('SellerProductId: ${pid.isEmpty ? '-' : pid}'),
                      ],
                    ),
                    actions: [
                      if (productUrl.isNotEmpty)
                        TextButton(
                          onPressed: () async {
                            final uri = Uri.tryParse(productUrl);
                            if (uri != null) {
                              await launchUrl(uri,
                                  mode: LaunchMode.externalApplication);
                            }
                          },
                          child: const Text('기존 상품 열기'),
                        ),
                      TextButton(
                        onPressed: () {
                          Navigator.of(context).pop();
                          unawaited(_executeUpload(force: true));
                        },
                        child: const Text('강제 재업로드'),
                      ),
                      TextButton(
                        onPressed: () => Navigator.of(context).pop(),
                        child: const Text('취소'),
                      ),
                    ],
                  );
                },
              );
              return;
            }
          }
        } catch (_) {}
        setState(() => _error = '이미 등록된 상품입니다.');
      } else {
        setState(() => _error = e.toString());
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _pollJob() async {
    final jobId = (_activeJob?['id'] ?? '').toString();
    if (jobId.isEmpty) return;

    for (var i = 0; i < 90; i++) {
      await Future.delayed(const Duration(seconds: 2));
      try {
        final json = await widget.api.getJson('/api/jobs/$jobId');
        final job = (json['job'] as Map?)?.cast<String, dynamic>();
        if (job == null) continue;
        if (!mounted) return;
        setState(() => _activeJob = job);

        final status = (job['status'] ?? '').toString();
        if (status == 'success' || status == 'failed') {
          final kind = (job['kind'] ?? '').toString();
          final result = (job['result'] as Map?)?.cast<String, dynamic>();
          if (kind == 'preview') {
            setState(() {
              _preview = (result?['preview'] as Map?)?.cast<String, dynamic>();
            });
          } else if (kind == 'upload') {
            setState(() {
              _uploadResult =
                  (result?['result'] as Map?)?.cast<String, dynamic>();
            });
          }
          unawaited(_refresh());
          return;
        }
      } catch (_) {
        // ignore polling errors
      }
    }
  }

  Future<void> _previewFromUrl() async {
    return _startJob('preview');
  }

  String _humanizeUploadError(Map<String, dynamic>? r) {
    final code = (r?['error'] ?? '').toString();
    if (code.isEmpty) return '';
    switch (code) {
      case 'duplicate_product':
        return '이미 등록된 상품입니다.';
      case 'shipping_fee_unknown':
        return '배송비가 유료로 표시되지만 금액을 확인할 수 없어 업로드를 중단했습니다.';
      case 'coupang_create_failed':
        final detail = r?['detail'];
        if (detail is Map) {
          final msg = (detail['message'] ?? '').toString();
          if (msg.isNotEmpty) return msg;
        }
        return '쿠팡 상품 생성에 실패했습니다.';
      case 'image_host_unreachable':
        return '이미지 호스트에 접근할 수 없어 업로드를 중단했습니다.';
      default:
        return '업로드 실패: $code';
    }
  }

  Future<void> _executeUpload({bool force = false}) async {
    if (force) {
      setState(() => _forceUpload = true);
    }
    return _startJob('upload');
  }

  Future<void> _confirmThenUpload() async {
    final u = _url.text.trim();
    if (u.isEmpty) {
      setState(() => _error = 'URL을 입력하세요.');
      return;
    }

    // Optional escape hatch
    if (_skipPreviewBeforeUpload) {
      await _executeUpload();
      return;
    }

    setState(() {
      _loading = true;
      _error = null;
      _uploadResult = null;
    });

    try {
      final json = await widget.api.postJson('/api/upload/preview', {
        'url': u,
        if ((_selectedPresetId ?? '').trim().isNotEmpty)
          'presetId': (_selectedPresetId ?? '').trim(),
      });
      final preview = (json['preview'] as Map?)?.cast<String, dynamic>();
      if (preview == null) {
        setState(() => _error = '미리보기 응답이 비었습니다.');
        return;
      }

      if (!mounted) return;
      setState(() {
        _preview = preview;
        _loginRequired = false;
      });

      // Pull suggestions from preview
      final sug =
          (preview['titleSuggestions'] as Map?)?.cast<String, dynamic>();
      final list = (sug?['suggestions'] as List?) ?? const [];
      final suggestions = list
          .map((e) => (e as Map).cast<String, dynamic>())
          .map((m) => (m['title'] ?? '').toString().trim())
          .where((t) => t.isNotEmpty)
          .toList();

      final draft = (preview['draft'] as Map?)?.cast<String, dynamic>() ?? {};
      final computed =
          (preview['computed'] as Map?)?.cast<String, dynamic>() ?? {};
      final title = (draft['title'] ?? '').toString();
      final finalPrice = computed['finalPrice'];
      final cat = (preview['category'] as Map?)?.cast<String, dynamic>() ?? {};
      final usedCode = (cat['usedCode'] ?? '').toString();
      final predicted = (cat['predicted'] as Map?)?.cast<String, dynamic>();
      final predictedName = (predicted?['name'] ?? '').toString();
      final predictedId = (predicted?['id'] ?? '').toString();

      final imagesRaw = (computed['images'] as List?) ?? const [];
      final images = imagesRaw
          .map((e) => e.toString())
          .where((s) => s.trim().isNotEmpty)
          .toList();

      // Auto-filter likely banner/notice images by default (user can re-add in edit).
      if ((_imagesOverride == null || (_imagesOverride ?? const []).isEmpty) &&
          images.isNotEmpty) {
        final filtered = images.where((u) => !isLikelyBannerUrl(u)).toList();
        _imagesOverride = filtered.isNotEmpty ? filtered : images;
      }

      final titleController =
          TextEditingController(text: (_titleOverride ?? '').trim());

      final proceed = await showModalBottomSheet<bool>(
        context: context,
        isScrollControlled: true,
        showDragHandle: true,
        builder: (ctx) {
          return StatefulBuilder(
            builder: (ctx, setInner) {
              return SafeArea(
                child: Padding(
                  padding: EdgeInsets.only(
                    left: 16,
                    right: 16,
                    top: 10,
                    bottom: 16 + MediaQuery.of(ctx).viewInsets.bottom,
                  ),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text('업로드 전 확인',
                          style: TextStyle(
                              fontSize: 16, fontWeight: FontWeight.w900)),
                      const SizedBox(height: 8),
                      Text(
                        title.isEmpty ? '(제목 없음)' : title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontWeight: FontWeight.w800),
                      ),
                      const SizedBox(height: 6),
                      Text('최종가: ${finalPrice ?? '-'}',
                          style: TextStyle(
                              color: Theme.of(ctx)
                                  .colorScheme
                                  .onSurface
                                  .withValues(alpha: 0.7))),
                      if (usedCode.trim().isNotEmpty) ...[
                        const SizedBox(height: 6),
                        Text(
                          '카테고리 코드: $usedCode'
                          '${predictedName.trim().isNotEmpty ? ' · 예측: $predictedName' : ''}'
                          '${predictedId.trim().isNotEmpty ? '($predictedId)' : ''}',
                          style: TextStyle(
                            fontSize: 12,
                            color: Theme.of(ctx)
                                .colorScheme
                                .onSurface
                                .withValues(alpha: 0.65),
                          ),
                        ),
                      ],
                      const SizedBox(height: 12),
                      if (images.isNotEmpty) ...[
                        Row(
                          children: [
                            const Expanded(
                              child: Text('이미지 미리보기',
                                  style:
                                      TextStyle(fontWeight: FontWeight.w900)),
                            ),
                            TextButton(
                              onPressed: () async {
                                final next = await Navigator.of(context)
                                    .push<List<String>>(
                                  MaterialPageRoute(
                                    builder: (_) => ImageEditScreen(
                                      initial: _imagesOverride ?? images,
                                      all: images,
                                      mapUrl: widget.api.proxyImageUrl,
                                    ),
                                  ),
                                );
                                if (next != null) {
                                  setState(() => _imagesOverride = next);
                                  setInner(() {});
                                }
                              },
                              child: const Text('편집'),
                            ),
                          ],
                        ),
                        const SizedBox(height: 8),
                        SizedBox(
                          height: 78,
                          child: ListView.separated(
                            scrollDirection: Axis.horizontal,
                            itemCount:
                                (_imagesOverride ?? images).take(12).length,
                            separatorBuilder: (_, __) =>
                                const SizedBox(width: 8),
                            itemBuilder: (_, i) {
                              final src = (_imagesOverride ?? images)[i];
                              return InkWell(
                                borderRadius: BorderRadius.circular(10),
                                onTap: () {
                                  Navigator.of(context).push(
                                    MaterialPageRoute(
                                      builder: (_) => ImageViewerScreen(
                                        images: (_imagesOverride ?? images),
                                        initialIndex: i,
                                        title: '이미지 미리보기',
                                        mapUrl: widget.api.proxyImageUrl,
                                      ),
                                    ),
                                  );
                                },
                                child: ClipRRect(
                                  borderRadius: BorderRadius.circular(10),
                                  child: AspectRatio(
                                    aspectRatio: 1,
                                    child: Image.network(
                                      widget.api.proxyImageUrl(src),
                                      fit: BoxFit.cover,
                                      errorBuilder: (_, __, ___) => Container(
                                        color: Theme.of(ctx)
                                            .colorScheme
                                            .surfaceContainerHighest,
                                        child: Icon(Icons.broken_image,
                                            color: Theme.of(ctx)
                                                .colorScheme
                                                .onSurface
                                                .withValues(alpha: 0.5)),
                                      ),
                                    ),
                                  ),
                                ),
                              );
                            },
                          ),
                        ),
                        const SizedBox(height: 12),
                      ],
                      if (suggestions.isNotEmpty) ...[
                        const Text('추천 제목(15자)',
                            style: TextStyle(fontWeight: FontWeight.w900)),
                        const SizedBox(height: 6),
                        Wrap(
                          spacing: 6,
                          runSpacing: 6,
                          children: suggestions.take(3).map((t) {
                            final selected =
                                titleController.text.trim() == t.trim();
                            return ActionChip(
                              label: Text(t),
                              onPressed: () {
                                titleController.text = t;
                                _titleOverride = t;
                                setInner(() {});
                              },
                              backgroundColor: selected
                                  ? Theme.of(ctx).colorScheme.primary
                                  : null,
                              labelStyle: TextStyle(
                                  color: selected
                                      ? Theme.of(ctx).colorScheme.onPrimary
                                      : null),
                            );
                          }).toList(),
                        ),
                        const SizedBox(height: 10),
                      ],
                      TextField(
                        decoration: const InputDecoration(
                          labelText: '제품명(선택)',
                          hintText: '비우면 자동 추천 제목이 적용될 수 있어요',
                        ),
                        controller: titleController,
                        onChanged: (v) {
                          _titleOverride = v;
                          setInner(() {});
                        },
                      ),
                      const SizedBox(height: 14),
                      Row(
                        children: [
                          Expanded(
                            child: OutlinedButton(
                              onPressed: () => Navigator.of(ctx).pop(false),
                              child: const Text('취소'),
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: FilledButton(
                              onPressed: () => Navigator.of(ctx).pop(true),
                              child: const Text('업로드 실행'),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              );
            },
          );
        },
      );

      if (proceed == true) {
        // 1) Save to catalog (confirmed snapshot)
        Map<String, dynamic>? product;
        try {
          final cjson = await widget.api.postJson('/api/catalog/confirm', {
            'sourceUrl': u,
            if ((_selectedPresetId ?? '').trim().isNotEmpty)
              'presetId': (_selectedPresetId ?? '').trim(),
            if ((_titleOverride ?? '').trim().isNotEmpty)
              'confirmedTitle': (_titleOverride ?? '').trim(),
            'mainImageUrl': (draft['imageUrl'] ?? '').toString(),
            if ((_imagesOverride ?? const []).isNotEmpty)
              'detailImages': (_imagesOverride ?? const []),
            // If preview category used code exists, keep as override by default.
            if (int.tryParse(usedCode) != null)
              'categoryOverride': int.parse(usedCode),
          });
          product = (cjson['product'] as Map?)?.cast<String, dynamic>();
        } catch (_) {
          product = null;
        }

        // 2) Deploy via catalog (creates an upload job linked to catalogId)
        final pid = (product?['id'] ?? '').toString();
        if (pid.isNotEmpty) {
          final deploy = await widget.api.postJson('/api/catalog/$pid/deploy', {});
          final job = (deploy['job'] as Map?)?.cast<String, dynamic>();
          setState(() {
            _activeJob = job;
          });
          unawaited(_pollJob());
        } else {
          // Fallback: legacy upload job
          await _executeUpload();
        }
      }
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

  Future<Map<String, dynamic>?> _pollJobById(String jobId) async {
    for (var i = 0; i < 120; i++) {
      await Future.delayed(const Duration(seconds: 2));
      try {
        final json = await widget.api.getJson('/api/jobs/$jobId');
        final job = (json['job'] as Map?)?.cast<String, dynamic>();
        if (job == null) continue;
        final status = (job['status'] ?? '').toString();
        if (status == 'success' || status == 'failed') return job;
      } catch (_) {
        // ignore
      }
    }
    return null;
  }

  Future<void> _runBatch() async {
    if (_queue.isEmpty) return;

    setState(() {
      _batchRunning = true;
      _error = null;
    });

    try {
      for (var i = 0; i < _queue.length; i++) {
        if (!_batchRunning) break;
        final item = _queue[i];
        if (item.status == _QueueStatus.success ||
            item.status == _QueueStatus.failed ||
            item.status == _QueueStatus.skipped) {
          continue;
        }

        // 1) preview
        Map<String, dynamic>? preview;
        try {
          final json = await widget.api.postJson('/api/upload/preview', {
            'url': item.url,
            if ((_selectedPresetId ?? '').trim().isNotEmpty)
              'presetId': (_selectedPresetId ?? '').trim(),
          });
          preview = (json['preview'] as Map?)?.cast<String, dynamic>();
          item.preview = preview;
        } catch (e) {
          item.status = _QueueStatus.failed;
          item.error = e.toString();
          if (mounted) setState(() {});
          continue;
        }

        if (!mounted) return;

        // 2) per-item confirm
        final decision = await showModalBottomSheet<String>(
          context: context,
          isScrollControlled: true,
          showDragHandle: true,
          builder: (ctx) {
            final draft =
                (preview?['draft'] as Map?)?.cast<String, dynamic>() ?? {};
            final computed =
                (preview?['computed'] as Map?)?.cast<String, dynamic>() ?? {};
            final title = (draft['title'] ?? '').toString();
            final finalPrice = computed['finalPrice'];
            return SafeArea(
              child: Padding(
                padding: const EdgeInsets.only(
                  left: 16,
                  right: 16,
                  top: 10,
                  bottom: 16,
                ),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    const Text('배치 업로드 - 개별 확인',
                        style: TextStyle(
                            fontSize: 16, fontWeight: FontWeight.w900)),
                    const SizedBox(height: 8),
                    Text(title.isEmpty ? '(제목 없음)' : title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontWeight: FontWeight.w800)),
                    const SizedBox(height: 6),
                    Text('최종가: ${finalPrice ?? '-'}',
                        style: TextStyle(
                            color: Theme.of(ctx)
                                .colorScheme
                                .onSurface
                                .withValues(alpha: 0.7))),
                    const SizedBox(height: 6),
                    Text(item.url,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                            fontSize: 12,
                            color: Theme.of(ctx)
                                .colorScheme
                                .onSurface
                                .withValues(alpha: 0.6))),
                    const SizedBox(height: 14),
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton(
                            onPressed: () => Navigator.of(ctx).pop('skip'),
                            child: const Text('스킵'),
                          ),
                        ),
                        const SizedBox(width: 10),
                        Expanded(
                          child: FilledButton(
                            onPressed: () => Navigator.of(ctx).pop('upload'),
                            child: const Text('업로드'),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    SizedBox(
                      width: double.infinity,
                      child: TextButton(
                        onPressed: () => Navigator.of(ctx).pop('stop'),
                        child: const Text('배치 중단'),
                      ),
                    ),
                  ],
                ),
              ),
            );
          },
        );

        if (decision == 'stop') {
          setState(() => _batchRunning = false);
          break;
        }

        if (decision != 'upload') {
          item.status = _QueueStatus.skipped;
          if (mounted) setState(() {});
          continue;
        }

        // 3) upload
        item.status = _QueueStatus.uploading;
        item.error = null;
        if (mounted) setState(() {});

        try {
          // 1) confirm to catalog
          final draft =
              (preview?['draft'] as Map?)?.cast<String, dynamic>() ?? {};
          final computed =
              (preview?['computed'] as Map?)?.cast<String, dynamic>() ?? {};
          final cat =
              (preview?['category'] as Map?)?.cast<String, dynamic>() ?? {};
          final usedCode = (cat['usedCode'] ?? '').toString();

          final imagesRaw = (computed['images'] as List?) ?? const [];
          final images = imagesRaw
              .map((e) => e.toString())
              .where((s) => s.trim().isNotEmpty)
              .toList();

          final cjson = await widget.api.postJson('/api/catalog/confirm', {
            'sourceUrl': item.url,
            if ((_selectedPresetId ?? '').trim().isNotEmpty)
              'presetId': (_selectedPresetId ?? '').trim(),
            'confirmedTitle': (draft['title'] ?? '').toString(),
            'mainImageUrl': (draft['imageUrl'] ?? '').toString(),
            if (images.isNotEmpty) 'detailImages': images,
            if (int.tryParse(usedCode) != null)
              'categoryOverride': int.parse(usedCode),
          });
          final product = (cjson['product'] as Map?)?.cast<String, dynamic>();
          final pid = (product?['id'] ?? '').toString();
          if (pid.isEmpty) throw Exception('catalog product id missing');

          // 2) deploy
          final djson =
              await widget.api.postJson('/api/catalog/$pid/deploy', {});
          final job = (djson['job'] as Map?)?.cast<String, dynamic>();
          final jobId = (job?['id'] ?? '').toString();
          if (jobId.isEmpty) throw Exception('jobId missing');

          final done = await _pollJobById(jobId);
          final status = (done?['status'] ?? '').toString();
          final result = (done?['result'] as Map?)?.cast<String, dynamic>();
          item.uploadResult =
              (result?['result'] as Map?)?.cast<String, dynamic>();

          if (status == 'success') {
            item.status = _QueueStatus.success;
          } else {
            item.status = _QueueStatus.failed;
            item.error = _humanizeUploadError(item.uploadResult);
            if ((item.error ?? '').isEmpty) {
              item.error = (done?['errorMessage'] ?? '업로드 실패').toString();
            }
          }
        } catch (e) {
          item.status = _QueueStatus.failed;
          item.error = e.toString();
        }

        if (mounted) setState(() {});
      }

      unawaited(_refresh());
    } finally {
      if (mounted) {
        setState(() => _batchRunning = false);
      }
    }
  }

  // 주문 관련 기능은 주문 탭으로 이동했습니다.
  // (Work 탭은 상품 업로드 전용)

  // 매입/벤더 업로드 기능은 추후 "주문" 탭으로 이동할 예정입니다.

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
    // 주문/결제 URL은 주문 탭으로 이동했습니다.
    // final payUrls = (dash?['payUrls'] as Map?) ?? {};

    final preview = _preview;
    final previewDraft = (preview?['draft'] as Map?) ?? {};
    final previewComputed = (preview?['computed'] as Map?) ?? {};

    final previewTitle = (previewDraft['title'] ?? '').toString();
    final titleSuggestions =
        (preview?['titleSuggestions'] as Map?)?.cast<String, dynamic>();
    final suggestionList =
        (titleSuggestions?['suggestions'] as List?) ?? const [];
    final previewImage = (previewDraft['imageUrl'] ?? '').toString();
    final previewFinalPrice = previewComputed['finalPrice'];
    final previewOptions = (preview?['options'] as List?) ?? const [];

    return AppScaffold(
      title: '상품 업로드',
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
                  const SectionHeader('로그인이 필요해요'),
                  const SizedBox(height: 10),
                  Text(
                    'Work 탭은 로그인 후 사용할 수 있어요. 더보기 탭에서 로그인해 주세요.',
                    style: TextStyle(
                        color: Theme.of(context)
                            .colorScheme
                            .onSurface
                            .withValues(alpha: 0.65)),
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
                const SectionHeader('URL → 미리보기 / 업로드'),
                const SizedBox(height: 10),
                DropdownButtonFormField<String?>(
                  initialValue: (_selectedPresetId != null &&
                          _presets.any((p) => p['id'] == _selectedPresetId))
                      ? _selectedPresetId
                      : null,
                  items: [
                    const DropdownMenuItem<String?>(
                      value: null,
                      child: Text('기본 설정(현재)'),
                    ),
                    ..._presets.map((p) {
                      final id = (p['id'] ?? '').toString();
                      final name = (p['name'] ?? '').toString();
                      return DropdownMenuItem<String?>(
                        value: id,
                        child: Text(name.isEmpty ? id : name),
                      );
                    }),
                  ],
                  onChanged: (!isAuthed || _loading)
                      ? null
                      : (v) => setState(() => _selectedPresetId = v),
                  decoration: const InputDecoration(
                    labelText: '프리셋(선택)',
                    helperText: '선택하면 미리보기/업로드/배치에 동일하게 적용돼요',
                  ),
                ),
                const SizedBox(height: 10),
                ValueListenableBuilder<TextEditingValue>(
                  valueListenable: _url,
                  builder: (context, value, _) {
                    final hasText = value.text.trim().isNotEmpty;
                    return TextField(
                      controller: _url,
                      enabled: isAuthed && !_loading,
                      decoration: InputDecoration(
                        labelText: '상품 URL (도매매/도매꾹)',
                        hintText: 'https://mobile.domeggook.com/...',
                        suffixIcon: hasText
                            ? IconButton(
                                tooltip: '지우기',
                                onPressed: (!isAuthed || _loading)
                                    ? null
                                    : () {
                                        _url.clear();
                                        setState(() {
                                          _preview = null;
                                          _uploadResult = null;
                                          _error = null;
                                        });
                                      },
                                icon: const Icon(Icons.clear),
                              )
                            : null,
                      ),
                    );
                  },
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed:
                            (!isAuthed || _loading) ? null : _previewFromUrl,
                        child: const Text('미리보기'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: FilledButton(
                        onPressed: (!isAuthed || _loading)
                            ? null
                            : () => _confirmThenUpload(),
                        child: const Text('업로드 실행'),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Theme(
                  data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
                  child: ExpansionTile(
                    tilePadding: EdgeInsets.zero,
                    childrenPadding: EdgeInsets.zero,
                    title: const Text('고급 옵션', style: TextStyle(fontWeight: FontWeight.w900)),
                    subtitle: Text(
                      '중복 허용/컨펌 생략 같은 옵션',
                      style: TextStyle(
                        fontSize: 12,
                        color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.65),
                      ),
                    ),
                    children: [
                      Row(
                        children: [
                          Switch(
                            value: _forceUpload,
                            onChanged: (!isAuthed || _loading)
                                ? null
                                : (v) => setState(() => _forceUpload = v),
                          ),
                          const SizedBox(width: 6),
                          Expanded(
                            child: Text(
                              '강제 재업로드(중복 허용)',
                              style: TextStyle(
                                fontSize: 12,
                                color: Theme.of(context)
                                    .colorScheme
                                    .onSurface
                                    .withValues(alpha: 0.65),
                              ),
                            ),
                          ),
                        ],
                      ),
                      Row(
                        children: [
                          Switch(
                            value: _skipPreviewBeforeUpload,
                            onChanged: (!isAuthed || _loading)
                                ? null
                                : (v) => setState(() => _skipPreviewBeforeUpload = v),
                          ),
                          const SizedBox(width: 6),
                          Expanded(
                            child: Text(
                              '바로 업로드(미리보기/컨펌 생략)',
                              style: TextStyle(
                                fontSize: 12,
                                color: Theme.of(context)
                                    .colorScheme
                                    .onSurface
                                    .withValues(alpha: 0.65),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
                if (_activeJob != null) ...[
                  const SizedBox(height: 6),
                  KvRow(
                    k: '작업 상태',
                    v: _humanizeJobStatus(
                        (_activeJob?['status'] ?? '').toString()),
                  ),
                  KvRow(
                    k: '작업 ID',
                    v: (_activeJob?['id'] ?? '-').toString(),
                  ),
                ],
                if (preview != null) ...[
                  const Divider(height: 28),
                  InkWell(
                    borderRadius: BorderRadius.circular(14),
                    onTap: () {
                      Navigator.of(context).push(
                        MaterialPageRoute(
                          builder: (_) => PreviewDetailScreen(
                            api: widget.api,
                            url:
                                (preview['url'] ?? _url.text).toString().trim(),
                            preview: preview,
                          ),
                        ),
                      );
                    },
                    child: Padding(
                      padding: const EdgeInsets.all(6),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          _Thumb(url: previewImage),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  previewTitle.isEmpty
                                      ? '(제목 없음)'
                                      : previewTitle,
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                  style: const TextStyle(
                                      fontWeight: FontWeight.w900),
                                ),
                                const SizedBox(height: 6),
                                Text(
                                  '최종가: ${previewFinalPrice ?? '-'} · 옵션: ${previewOptions.length}개',
                                  style: TextStyle(
                                    fontSize: 12,
                                    color: Theme.of(context)
                                        .colorScheme
                                        .onSurface
                                        .withValues(alpha: 0.65),
                                  ),
                                ),
                                const SizedBox(height: 10),
                                Text(
                                  '탭해서 상세 미리보기 보기',
                                  style: TextStyle(
                                    fontSize: 12,
                                    fontWeight: FontWeight.w700,
                                    color: Theme.of(context)
                                        .colorScheme
                                        .primary
                                        .withValues(alpha: 0.95),
                                  ),
                                ),
                                if (suggestionList.isNotEmpty) ...[
                                  const SizedBox(height: 10),
                                  Text(
                                    '추천 제목(15자)',
                                    style: TextStyle(
                                      fontSize: 12,
                                      fontWeight: FontWeight.w800,
                                      color: Theme.of(context)
                                          .colorScheme
                                          .onSurface
                                          .withValues(alpha: 0.85),
                                    ),
                                  ),
                                  const SizedBox(height: 6),
                                  Wrap(
                                    spacing: 6,
                                    runSpacing: 6,
                                    children: suggestionList
                                        .take(3)
                                        .map((e) =>
                                            (e as Map).cast<String, dynamic>())
                                        .map((s) {
                                      final t = (s['title'] ?? '').toString();
                                      final selected =
                                          (_titleOverride ?? '').trim() ==
                                              t.trim();
                                      return ActionChip(
                                        label: Text(t),
                                        onPressed: t.isEmpty
                                            ? null
                                            : () => setState(
                                                () => _titleOverride = t),
                                        backgroundColor: selected
                                            ? Theme.of(context)
                                                .colorScheme
                                                .primary
                                            : null,
                                        labelStyle: TextStyle(
                                          color: selected
                                              ? Theme.of(context)
                                                  .colorScheme
                                                  .onPrimary
                                              : null,
                                        ),
                                      );
                                    }).toList(),
                                  ),
                                ],
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
                if (_uploadResult != null) ...[
                  const Divider(height: 28),
                  KvRow(
                      k: '업로드 성공',
                      v: (_uploadResult?['ok'] == true) ? '예' : '아니오'),
                  KvRow(
                      k: 'SellerProductId',
                      v: (_uploadResult?['create'] as Map?)?['sellerProductId']
                              ?.toString() ??
                          '-'),
                  if ((_uploadResult?['error'] ?? '').toString().isNotEmpty)
                    KvRow(k: '오류', v: _humanizeUploadError(_uploadResult)),
                ],
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SectionHeader('배치 업로드 큐',
                    trailing: InfoChip(label: '${_queue.length}')),
                const SizedBox(height: 10),
                TextField(
                  controller: _batchUrls,
                  enabled: isAuthed && !_loading && !_batchRunning,
                  minLines: 3,
                  maxLines: 6,
                  decoration: const InputDecoration(
                    labelText: '여러 URL 입력',
                    hintText: '줄바꿈 또는 쉼표(,)로 여러 URL을 붙여넣기',
                  ),
                ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed: (!isAuthed || _loading || _batchRunning)
                            ? null
                            : () {
                                final added = _enqueueFromText(_batchUrls.text);
                                if (added > 0) {
                                  _batchUrls.clear();
                                  ScaffoldMessenger.of(context).showSnackBar(
                                    SnackBar(content: Text('큐에 $added개 추가됨')),
                                  );
                                }
                              },
                        child: const Text('큐에 추가'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: FilledButton(
                        onPressed: (!isAuthed ||
                                _loading ||
                                _batchRunning ||
                                _queue.isEmpty)
                            ? null
                            : _runBatch,
                        child: Text(_batchRunning ? '진행중...' : '배치 시작'),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Expanded(
                      child: TextButton(
                        onPressed: (_batchRunning || _queue.isEmpty)
                            ? null
                            : () => setState(() {
                                  _queue.clear();
                                }),
                        child: const Text('큐 비우기'),
                      ),
                    ),
                    if (_batchRunning)
                      TextButton(
                        onPressed: () => setState(() => _batchRunning = false),
                        child: const Text('중단'),
                      ),
                  ],
                ),
                if (_queue.isNotEmpty) ...[
                  const Divider(height: 24),
                  ListView.separated(
                    shrinkWrap: true,
                    physics: const NeverScrollableScrollPhysics(),
                    itemCount: _queue.length,
                    separatorBuilder: (_, __) => const Divider(height: 18),
                    itemBuilder: (_, i) {
                      final it = _queue[i];
                      final st = it.status;
                      String statusText = '대기';
                      if (st == _QueueStatus.confirmed) {
                        statusText = '확인됨';
                      }
                      if (st == _QueueStatus.uploading) {
                        statusText = '업로드중';
                      }
                      if (st == _QueueStatus.success) {
                        statusText = '완료';
                      }
                      if (st == _QueueStatus.failed) {
                        statusText = '실패';
                      }
                      if (st == _QueueStatus.skipped) {
                        statusText = '스킵';
                      }

                      Color color = Theme.of(context).colorScheme.outline;
                      if (st == _QueueStatus.success) {
                        color = const Color(0xFF2F9E44);
                      }
                      if (st == _QueueStatus.failed) {
                        color = const Color(0xFFE03131);
                      }
                      if (st == _QueueStatus.uploading) {
                        color = const Color(0xFF1971C2);
                      }

                      return Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          InfoChip(label: statusText, color: color),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(it.url,
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(
                                        fontWeight: FontWeight.w800)),
                                if ((it.error ?? '').isNotEmpty) ...[
                                  const SizedBox(height: 4),
                                  Text(it.error!,
                                      style: TextStyle(
                                        fontSize: 12,
                                        color: Theme.of(context)
                                            .colorScheme
                                            .onSurface
                                            .withValues(alpha: 0.65),
                                      )),
                                ],
                              ],
                            ),
                          ),
                          if (!_batchRunning)
                            IconButton(
                              tooltip: '삭제',
                              onPressed: () =>
                                  setState(() => _queue.removeAt(i)),
                              icon: const Icon(Icons.delete_outline),
                            ),
                        ],
                      );
                    },
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Text(
              '주문 관련 기능은 이제 “주문” 탭에서 할 수 있어요.\n\n아래로 내려서 상품 미리보기/업로드만 진행해 주세요.',
              style: TextStyle(
                color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.8),
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SectionHeader('최근 미리보기',
                    trailing: InfoChip(label: '${previewHistory.length}')),
                const SizedBox(height: 10),
                if (!isAuthed)
                  Text(
                    '로그인 후 확인할 수 있어요.',
                    style: TextStyle(
                        color: Theme.of(context)
                            .colorScheme
                            .onSurface
                            .withValues(alpha: 0.65)),
                  )
                else if (previewHistory.isEmpty)
                  Text(
                    '아직 히스토리가 없어요. 미리보기를 실행한 뒤 다시 확인해보세요.',
                    style: TextStyle(
                        color: Theme.of(context)
                            .colorScheme
                            .onSurface
                            .withValues(alpha: 0.65)),
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

                      final options = (item['options'] as List?) ?? const [];
                      final images = (item['images'] as List?) ?? const [];
                      final sourcePrice = item['sourcePrice'];

                      // Build a minimal preview payload for PreviewDetailScreen.
                      final previewPayload = <String, dynamic>{
                        'draft': {
                          'title': title,
                          'price': sourcePrice,
                          'imageUrl': imageUrl,
                          'sourceUrl': url,
                        },
                        'computed': {
                          'finalPrice': finalPrice,
                          'images': images,
                          'optionsCount': options.length,
                        },
                        'options': options,
                        'url': url,
                        'ok': true,
                      };

                      return InkWell(
                        borderRadius: BorderRadius.circular(12),
                        onTap: () {
                          if (url.trim().isEmpty) return;
                          Navigator.of(context).push(
                            MaterialPageRoute(
                              builder: (_) => PreviewDetailScreen(
                                api: widget.api,
                                url: url.trim(),
                                preview: previewPayload,
                              ),
                            ),
                          );
                        },
                        child: Padding(
                          padding: const EdgeInsets.symmetric(vertical: 4),
                          child: Row(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              _Thumb(url: widget.api.proxyImageUrl(imageUrl)),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      title.isEmpty ? '(제목 없음)' : title,
                                      maxLines: 2,
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(
                                          fontWeight: FontWeight.w800),
                                    ),
                                    const SizedBox(height: 6),
                                    Text(
                                      url,
                                      maxLines: 2,
                                      overflow: TextOverflow.ellipsis,
                                      style: TextStyle(
                                          fontSize: 12,
                                          color: Theme.of(context)
                                              .colorScheme
                                              .onSurface
                                              .withValues(alpha: 0.60)),
                                    ),
                                    const SizedBox(height: 6),
                                    Text(
                                      '옵션: ${options.length}개',
                                      style: TextStyle(
                                          fontSize: 12,
                                          color: Theme.of(context)
                                              .colorScheme
                                              .onSurface
                                              .withValues(alpha: 0.60)),
                                    ),
                                  ],
                                ),
                              ),
                              const SizedBox(width: 10),
                              Text(
                                finalPrice == null
                                    ? '-'
                                    : finalPrice.toString(),
                                style: const TextStyle(
                                    fontWeight: FontWeight.w900),
                              ),
                            ],
                          ),
                        ),
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
                SectionHeader('Recent purchase logs',
                    trailing: InfoChip(label: '${purchaseLogs.length}')),
                const SizedBox(height: 10),
                if (!isAuthed)
                  Text(
                    '로그인 후 확인할 수 있어요.',
                    style: TextStyle(
                        color: Theme.of(context)
                            .colorScheme
                            .onSurface
                            .withValues(alpha: 0.65)),
                  )
                else if (purchaseLogs.isEmpty)
                  Text(
                    '아직 로그가 없어요.',
                    style: TextStyle(
                        color: Theme.of(context)
                            .colorScheme
                            .onSurface
                            .withValues(alpha: 0.65)),
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
                            color: ok
                                ? const Color(0xFF2F9E44)
                                : const Color(0xFFE03131),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text('$type · $vendor',
                                    style: const TextStyle(
                                        fontWeight: FontWeight.w900)),
                                const SizedBox(height: 6),
                                Text(
                                  at,
                                  style: TextStyle(
                                      fontSize: 12,
                                      color: Theme.of(context)
                                          .colorScheme
                                          .onSurface
                                          .withValues(alpha: 0.60)),
                                ),
                                if ((it['error'] ?? '').toString().isNotEmpty)
                                  Padding(
                                    padding: const EdgeInsets.only(top: 6),
                                    child: Text(
                                      (it['error'] ?? '').toString(),
                                      style: TextStyle(
                                          fontSize: 12,
                                          color: Theme.of(context)
                                              .colorScheme
                                              .error),
                                    ),
                                  ),
                              ],
                            ),
                          ),
                          if (payUrl.startsWith('http'))
                            TextButton.icon(
                              onPressed: () => _openExternal(payUrl),
                              icon: const Icon(Icons.open_in_new, size: 18),
                              label: const Text('결제'),
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

  String _normalize(String raw) {
    final s = raw.trim();
    if (s.isEmpty) return '';
    if (s.startsWith('//')) return 'https:$s';
    if (s.startsWith('http://') || s.startsWith('https://')) return s;

    // Some sources provide host/path without scheme.
    if (s.startsWith('cdn') || s.contains('.')) {
      return 'https://$s'.replaceFirst('https:///','https://');
    }
    return s;
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final border = BorderRadius.circular(14);

    final u = _normalize(url);
    if (!u.startsWith('http')) {
      return Container(
        width: 48,
        height: 48,
        decoration: BoxDecoration(
          color: cs.primary.withValues(alpha: 0.08),
          borderRadius: border,
        ),
        child: Icon(Icons.image_outlined,
            color: cs.primary.withValues(alpha: 0.65)),
      );
    }

    return ClipRRect(
      borderRadius: border,
      child: Image.network(
        u,
        width: 48,
        height: 48,
        fit: BoxFit.cover,
        headers: const {
          'Referer': 'https://domeggook.com',
          'User-Agent': 'Mozilla/5.0',
        },
        errorBuilder: (_, __, ___) => Container(
          width: 48,
          height: 48,
          color: cs.primary.withValues(alpha: 0.08),
          child: Icon(
            Icons.broken_image_outlined,
            color: cs.primary.withValues(alpha: 0.65),
          ),
        ),
      ),
    );
  }
}
