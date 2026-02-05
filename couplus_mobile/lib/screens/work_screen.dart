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

class _WorkScreenState extends State<WorkScreen> {
  final _url = TextEditingController();
  final _dateFrom = TextEditingController();
  final _dateTo = TextEditingController();

  bool _loading = false;
  String? _error;
  bool _loginRequired = false;

  bool _forceUpload = false;
  bool _skipPreviewBeforeUpload = false;
  List<String>? _imagesOverride;

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
      final sug = (preview['titleSuggestions'] as Map?)?.cast<String, dynamic>();
      final list = (sug?['suggestions'] as List?) ?? const [];
      final suggestions = list
          .map((e) => (e as Map).cast<String, dynamic>())
          .map((m) => (m['title'] ?? '').toString().trim())
          .where((t) => t.isNotEmpty)
          .toList();

      final draft = (preview['draft'] as Map?)?.cast<String, dynamic>() ?? {};
      final computed = (preview['computed'] as Map?)?.cast<String, dynamic>() ?? {};
      final title = (draft['title'] ?? '').toString();
      final finalPrice = computed['finalPrice'];
      final imagesRaw = (computed['images'] as List?) ?? const [];
      final images = imagesRaw.map((e) => e.toString()).where((s) => s.trim().isNotEmpty).toList();

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
                                final next = await Navigator.of(context).push<List<String>>(
                                  MaterialPageRoute(
                                    builder: (_) => ImageEditScreen(
                                      initial: _imagesOverride ?? images,
                                      all: images,
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
                            itemCount: (_imagesOverride ?? images).take(12).length,
                            separatorBuilder: (_, __) => const SizedBox(width: 8),
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
                                      ),
                                    ),
                                  );
                                },
                                child: ClipRRect(
                                  borderRadius: BorderRadius.circular(10),
                                  child: AspectRatio(
                                    aspectRatio: 1,
                                    child: Image.network(
                                      src,
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
        await _executeUpload();
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
    final titleSuggestions = (preview?['titleSuggestions'] as Map?)?.cast<String, dynamic>();
    final suggestionList = (titleSuggestions?['suggestions'] as List?) ?? const [];
    final previewImage = (previewDraft['imageUrl'] ?? '').toString();
    final previewFinalPrice = previewComputed['finalPrice'];
    final previewOptions = (preview?['options'] as List?) ?? const [];

    return AppScaffold(
      title: '작업',
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
                                        .map((e) => (e as Map).cast<String, dynamic>())
                                        .map((s) {
                                      final t = (s['title'] ?? '').toString();
                                      final selected = (_titleOverride ?? '').trim() == t.trim();
                                      return ActionChip(
                                        label: Text(t),
                                        onPressed: t.isEmpty
                                            ? null
                                            : () => setState(() => _titleOverride = t),
                                        backgroundColor: selected
                                            ? Theme.of(context).colorScheme.primary
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
                const SectionHeader('주문 (쿠팡 → 도매매 엑셀)'),
                const SizedBox(height: 10),
                Row(
                  children: [
                    Expanded(
                      child: TextField(
                        controller: _dateFrom,
                        enabled: isAuthed && !_loading,
                        decoration: const InputDecoration(
                            labelText: '시작일 (YYYY-MM-DD)'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: TextField(
                        controller: _dateTo,
                        enabled: isAuthed && !_loading,
                        decoration: const InputDecoration(
                            labelText: '종료일 (YYYY-MM-DD)'),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed:
                            (!isAuthed || _loading) ? null : _ordersExport,
                        child: const Text('엑셀 생성'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: FilledButton(
                        onPressed:
                            (!isAuthed || _loading) ? null : _ordersUpload,
                        child: const Text('도매매 업로드'),
                      ),
                    ),
                  ],
                ),
                if (_ordersExportResult != null) ...[
                  const Divider(height: 28),
                  KvRow(
                      k: '파일 경로',
                      v: (_ordersExportResult?['filePath'] ?? '-').toString()),
                  KvRow(
                      k: '내보내기 성공',
                      v: (_ordersExportResult?['ok'] == true) ? '예' : '아니오'),
                ],
                if (_ordersUploadResult != null) ...[
                  const Divider(height: 28),
                  KvRow(
                      k: '업로드 성공',
                      v: (_ordersUploadResult?['ok'] == true) ? '예' : '아니오'),
                  if ((_ordersUploadResult?['error'] ?? '')
                      .toString()
                      .isNotEmpty)
                    KvRow(
                        k: '오류',
                        v: (_ordersUploadResult?['error'] ?? '').toString()),
                ],
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeader('매입(결제 완료 → 벤더 업로드)'),
                const SizedBox(height: 10),
                Row(
                  children: [
                    Expanded(
                      child: OutlinedButton(
                        onPressed:
                            (!isAuthed || _loading) ? null : _purchaseDraft,
                        child: const Text('초안 생성'),
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: FilledButton(
                        onPressed:
                            (!isAuthed || _loading) ? null : _purchaseUpload,
                        child: const Text('벤더 업로드'),
                      ),
                    ),
                  ],
                ),
                if (_purchaseDraftResult != null) ...[
                  const Divider(height: 28),
                  KvRow(
                      k: '결제완료 주문 수',
                      v: (_purchaseDraftResult?['paidOrderCount'] ?? '-')
                          .toString()),
                ],
                if (_purchaseUploadResult != null) ...[
                  const Divider(height: 28),
                  Text(
                    '업로드 결과',
                    style: TextStyle(
                        fontWeight: FontWeight.w900,
                        color: Theme.of(context).colorScheme.onSurface),
                  ),
                  const SizedBox(height: 8),
                  ...(((_purchaseUploadResult?['results'] as List?) ??
                          const []))
                      .map((it) {
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
                            color: ok
                                ? const Color(0xFF2F9E44)
                                : const Color(0xFFE03131),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Text(
                              ok ? '성공' : (row['error'] ?? '실패').toString(),
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          if (payUrl.startsWith('http'))
                            TextButton.icon(
                              onPressed: () => _openExternal(payUrl),
                              icon: const Icon(Icons.open_in_new, size: 18),
                              label: const Text('결제'),
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
                const SectionHeader('결제 URL(벤더별 최신)'),
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
                else if (payUrls.isEmpty)
                  Text(
                    '아직 결제 URL이 없어요.',
                    style: TextStyle(
                        color: Theme.of(context)
                            .colorScheme
                            .onSurface
                            .withValues(alpha: 0.65)),
                  )
                else
                  ...payUrls.entries.map((e) {
                    final vendor = e.key.toString();
                    final url = e.value.toString();
                    return Padding(
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      child: Row(
                        children: [
                          Expanded(
                              child: Text(vendor,
                                  style: const TextStyle(
                                      fontWeight: FontWeight.w800))),
                          TextButton.icon(
                            onPressed: () => _openExternal(url),
                            icon: const Icon(Icons.open_in_new, size: 18),
                            label: const Text('열기'),
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
                              _Thumb(url: imageUrl),
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
        child: Icon(Icons.image_outlined,
            color: cs.primary.withValues(alpha: 0.65)),
      );
    }

    return ClipRRect(
      borderRadius: border,
      child: Image.network(
        url,
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
