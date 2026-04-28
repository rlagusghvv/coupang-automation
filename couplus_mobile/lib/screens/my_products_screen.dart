import 'package:couplus_mobile/api/api_client.dart';
import 'package:couplus_mobile/screens/product_detail_screen.dart';
import 'package:couplus_mobile/ui/widgets.dart';
import 'package:couplus_mobile/utils/file_download.dart';
import 'package:couplus_mobile/utils/video_file_pick.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

class MyProductsScreen extends StatefulWidget {
  const MyProductsScreen({
    super.key,
    required this.api,
    this.initialStatus = '',
    this.initialRecoveryOnly = false,
    this.initialLowPriceOnly = false,
    this.initialQuery = '',
    this.titleOverride,
  });

  final ApiClient api;
  final String initialStatus;
  final bool initialRecoveryOnly;
  final bool initialLowPriceOnly;
  final String initialQuery;
  final String? titleOverride;

  @override
  State<MyProductsScreen> createState() => _MyProductsScreenState();
}

class _MyProductsScreenState extends State<MyProductsScreen> {
  bool _loading = false;
  bool _syncingStatus = false;
  bool _priceAuditBusy = false;
  bool _moqAuditBusy = false;
  bool _marketingBusy = false;
  String? _marketingBusyId;
  String? _error;
  String? _lastSyncSummary;
  String? _lastPriceAuditSummary;
  String? _lastMoqAuditSummary;
  List<Map<String, dynamic>> _products = const [];

  final _q = TextEditingController();
  String _status = '';
  bool _recoveryOnly = false;
  bool _lowPriceOnly = false;
  bool _selectMode = false;
  final Set<String> _selected = {};

  @override
  void initState() {
    super.initState();
    _status = widget.initialStatus.trim();
    _recoveryOnly = widget.initialRecoveryOnly;
    _lowPriceOnly = widget.initialLowPriceOnly;
    if (_lowPriceOnly) {
      _recoveryOnly = true;
    }
    if (widget.initialQuery.trim().isNotEmpty) {
      _q.text = widget.initialQuery.trim();
    }
    _refresh();
  }

  @override
  void dispose() {
    _q.dispose();
    super.dispose();
  }

  Future<void> _refresh({bool syncRemote = false}) async {
    setState(() {
      _loading = true;
      _error = null;
      if (syncRemote) _syncingStatus = true;
    });

    try {
      if (syncRemote) {
        try {
          final syncJson = await widget.api
              .postJson('/api/products/status/refresh', const {});
          final total = int.tryParse((syncJson['total'] ?? 0).toString()) ?? 0;
          final success =
              int.tryParse((syncJson['success'] ?? 0).toString()) ?? 0;
          final failed =
              int.tryParse((syncJson['failed'] ?? 0).toString()) ?? 0;
          _lastSyncSummary = '상태 동기화: 성공 $success / 실패 $failed (대상 $total)';
        } catch (syncErr) {
          _lastSyncSummary = '상태 동기화 실패: $syncErr';
        }
      }

      final json = await widget.api.getJson(
        '/api/catalog',
        query: {
          'limit': '200',
          if (_status.trim().isNotEmpty) 'status': _status.trim(),
          if (_q.text.trim().isNotEmpty) 'q': _q.text.trim(),
        },
      );
      final list = (json['products'] as List?) ?? const [];
      setState(() {
        _products =
            list.map((e) => (e as Map).cast<String, dynamic>()).toList();
      });
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) {
        setState(() {
          _loading = false;
          _syncingStatus = false;
        });
      }
    }
  }

  Future<void> _refreshWithStatusSync() => _refresh(syncRemote: true);

  Future<void> _bulkSync() async {
    if (_selected.isEmpty) return;
    setState(() {
      _loading = true;
      _error = null;
    });

    var okCount = 0;
    var skippedCount = 0;
    var failedCount = 0;

    try {
      final byId = <String, Map<String, dynamic>>{
        for (final p in _products) (p['id'] ?? '').toString(): p,
      };

      for (final id in _selected) {
        final current = byId[id] ?? const <String, dynamic>{};
        final localSpid = (current['sellerProductId'] ?? '').toString().trim();
        if (localSpid.isEmpty) {
          skippedCount += 1;
          continue;
        }

        try {
          final json = await widget.api.postJson('/api/catalog/$id/sync', {});
          if (json['skipped'] == true) {
            skippedCount += 1;
          } else {
            okCount += 1;
          }
        } catch (_) {
          failedCount += 1;
        }
      }

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              '동기화 완료: 성공 $okCount · 스킵 $skippedCount · 실패 $failedCount',
            ),
          ),
        );
      }

      if (failedCount > 0 && mounted) {
        setState(
          () =>
              _error = '일부 동기화 실패 ($failedCount건). 다시 시도하거나 상세에서 개별 동기화해 주세요.',
        );
      }

      await _refresh(syncRemote: false);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _bulkRedeploy() async {
    if (_selected.isEmpty) return;
    setState(() => _loading = true);
    try {
      for (final id in _selected) {
        await widget.api.postJson('/api/catalog/$id/deploy', {});
      }
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('재배포 ${_selected.length}건 시작했어요.')),
        );
      }
      await _refresh(syncRemote: false);
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _bulkArchive() async {
    if (_selected.isEmpty) return;
    setState(() {
      _loading = true;
      _error = null;
    });

    var okCount = 0;
    var skippedCount = 0;
    var failedCount = 0;

    try {
      for (final id in _selected) {
        if (id.trim().isEmpty) {
          skippedCount += 1;
          continue;
        }
        try {
          await widget.api.postJson('/api/catalog/$id/archive', {});
          okCount += 1;
        } catch (_) {
          failedCount += 1;
        }
      }

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              '삭제 완료: 성공 $okCount · 스킵 $skippedCount · 실패 $failedCount',
            ),
          ),
        );
      }

      setState(() => _selected.clear());
      await _refresh(syncRemote: false);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _importBySellerProductId() async {
    final input = TextEditingController();
    final value = await showDialog<String>(
      context: context,
      builder: (ctx) {
        return AlertDialog(
          title: const Text('기존 쿠팡 상품 가져오기'),
          content: TextField(
            controller: input,
            autofocus: true,
            decoration: const InputDecoration(
              labelText: 'SellerProductId',
              hintText: '예) 1234567890',
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('취소'),
            ),
            FilledButton(
              onPressed: () => Navigator.of(ctx).pop(input.text.trim()),
              child: const Text('가져오기'),
            ),
          ],
        );
      },
    );

    if (!mounted) return;
    final sellerProductId = (value ?? '').trim();
    if (sellerProductId.isEmpty) return;

    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final json = await widget.api.postJson('/api/catalog/import', {
        'sellerProductId': sellerProductId,
      });
      final p = (json['product'] as Map?)?.cast<String, dynamic>();
      final savedId = (p?['id'] ?? '').toString();
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              savedId.isEmpty ? '가져오기를 완료했어요.' : '가져오기 완료: ID $savedId',
            ),
          ),
        );
      }
      await _refresh(syncRemote: false);
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _selectAllVisible() {
    final ids = _visibleProducts
        .map((p) => (p['id'] ?? '').toString())
        .where((id) => id.isNotEmpty)
        .toSet();
    setState(() {
      _selected
        ..clear()
        ..addAll(ids);
    });
  }

  void _clearSelection() {
    setState(() => _selected.clear());
  }

  Map<String, dynamic> _priceAuditOf(Map<String, dynamic> product) {
    final raw = product['priceAudit'];
    if (raw is Map) {
      return raw.cast<String, dynamic>();
    }
    return const <String, dynamic>{};
  }

  Map<String, dynamic> _moqAuditOf(Map<String, dynamic> product) {
    final raw = product['moqAudit'];
    if (raw is Map) {
      return raw.cast<String, dynamic>();
    }
    return const <String, dynamic>{};
  }

  Map<String, dynamic> _sourcePurchaseOf(Map<String, dynamic> product) {
    final raw = product['sourcePurchase'];
    if (raw is Map) {
      return raw.cast<String, dynamic>();
    }
    return const <String, dynamic>{};
  }

  Map<String, dynamic> _orderBlockOf(Map<String, dynamic> product) {
    final raw = product['orderBlock'];
    if (raw is Map) {
      return raw.cast<String, dynamic>();
    }
    return const <String, dynamic>{};
  }

  bool _isLowPriceFlagged(Map<String, dynamic> product) {
    final audit = _priceAuditOf(product);
    return audit['flagged'] == true;
  }

  int _minimumOrderQtyOf(Map<String, dynamic> product) {
    final orderBlock = _orderBlockOf(product);
    final sourcePurchase = _sourcePurchaseOf(product);
    final moqAudit = _moqAuditOf(product);
    final raw = orderBlock['minimumOrderQty'] ??
        sourcePurchase['minimumOrderQty'] ??
        moqAudit['minimumOrderQty'] ??
        1;
    final parsed = int.tryParse(raw.toString());
    return parsed == null || parsed <= 0 ? 1 : parsed;
  }

  bool _isMoqFlagged(Map<String, dynamic> product) {
    final orderBlock = _orderBlockOf(product);
    final code = (orderBlock['code'] ?? '').toString().trim();
    if (code == 'minimum_order_qty_gt_1') return true;
    final moqAudit = _moqAuditOf(product);
    if (moqAudit['flagged'] == true) return true;
    return _minimumOrderQtyOf(product) > 1;
  }

  bool _isRecoveryProduct(Map<String, dynamic> product) {
    final status = (product['status'] ?? '').toString().trim().toLowerCase();
    return status == 'deployed_invalid' ||
        status == 'deploy_failed' ||
        status == 'draft_saved' ||
        _isLowPriceFlagged(product) ||
        _isMoqFlagged(product);
  }

  List<Map<String, dynamic>> get _visibleProducts {
    Iterable<Map<String, dynamic>> items = _products;
    if (_recoveryOnly) {
      items = items.where(_isRecoveryProduct);
    }
    if (_lowPriceOnly) {
      items = items.where(_isLowPriceFlagged);
    }
    return items.toList(growable: false);
  }

  String get _screenTitle {
    final override = widget.titleOverride?.trim() ?? '';
    final base = override.isNotEmpty
        ? override
        : _lowPriceOnly
            ? '저가 의심 상품'
            : _recoveryOnly
                ? '복구 큐'
                : '내 상품';
    return _selectMode ? '$base(선택 ${_selected.length})' : base;
  }

  String _formatPriceValue(dynamic raw) {
    final n = num.tryParse((raw ?? '').toString());
    if (n == null || !n.isFinite || n <= 0) return '-';
    return '${n.round().toString()}원';
  }

  String _priceAuditSummaryLine(Map<String, dynamic> product) {
    final audit = _priceAuditOf(product);
    if (audit.isEmpty) return '';
    final source = _formatPriceValue(audit['sourcePrice']);
    final current = _formatPriceValue(audit['liveSalePrice']);
    final expected = _formatPriceValue(audit['expectedFinalPrice']);
    return '공급 $source · 현재 $current · 예상 $expected';
  }

  String _moqSummaryLine(Map<String, dynamic> product) {
    final minimumOrderQty = _minimumOrderQtyOf(product);
    if (minimumOrderQty <= 1) return '';
    return '공급처 최소주문수량 $minimumOrderQty개 · 단건 주문 불가';
  }

  void _selectFlaggedVisible() {
    final ids = _visibleProducts
        .where((p) => _isLowPriceFlagged(p) || _isMoqFlagged(p))
        .map((p) => (p['id'] ?? '').toString().trim())
        .where((id) => id.isNotEmpty)
        .toSet();
    setState(() {
      _selectMode = true;
      _selected
        ..clear()
        ..addAll(ids);
    });
  }

  Future<void> _scanLowPriceMisparses() async {
    final ids = _visibleProducts
        .map((p) => (p['id'] ?? '').toString().trim())
        .where((id) => id.isNotEmpty)
        .toList();
    if (ids.isEmpty) return;
    const batchSize = 1;

    setState(() {
      _priceAuditBusy = true;
      _error = null;
      _lastPriceAuditSummary = '저가 검사 준비 중…';
    });

    try {
      final flaggedIds = <String>{};
      var scanned = 0;
      var flagged = 0;
      var skipped = 0;

      for (var start = 0; start < ids.length; start += batchSize) {
        final end =
            (start + batchSize > ids.length) ? ids.length : start + batchSize;
        final chunk = ids.sublist(start, end);
        if (mounted) {
          setState(() {
            _lastPriceAuditSummary =
                '저가 검사 중… ${start + 1}-$end / ${ids.length}';
          });
        }
        final json =
            await widget.api.postJson('/api/catalog/price-audit/scan', {
          'ids': chunk,
        });
        final items = (json['items'] as List?) ?? const [];
        for (final raw in items) {
          if (raw is! Map) continue;
          final item = raw.cast<String, dynamic>();
          if (item['flagged'] == true) {
            final product =
                (item['product'] as Map?)?.cast<String, dynamic>() ??
                    const <String, dynamic>{};
            final id = (product['id'] ?? item['id'] ?? '').toString().trim();
            if (id.isNotEmpty) flaggedIds.add(id);
          }
        }
        scanned += int.tryParse((json['scanned'] ?? 0).toString()) ?? 0;
        flagged += int.tryParse((json['flagged'] ?? 0).toString()) ?? 0;
        skipped += int.tryParse((json['skipped'] ?? 0).toString()) ?? 0;
      }

      await _refresh(syncRemote: false);
      if (!mounted) return;
      setState(() {
        _lastPriceAuditSummary =
            '저가 검사: 문제 $flagged건 · 스킵 $skipped건 (검사 $scanned건)';
        _selectMode = flaggedIds.isNotEmpty;
        _selected
          ..clear()
          ..addAll(flaggedIds);
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            flaggedIds.isNotEmpty
                ? '저가 의심 ${flaggedIds.length}건을 선택해 두었습니다.'
                : '저가 오파싱 의심 상품을 찾지 못했습니다.',
          ),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = '저가 검사 실패: $e');
    } finally {
      if (mounted) {
        setState(() => _priceAuditBusy = false);
      }
    }
  }

  Future<void> _scanMoqIssues() async {
    final ids = _visibleProducts
        .map((p) => (p['id'] ?? '').toString().trim())
        .where((id) => id.isNotEmpty)
        .toList();
    if (ids.isEmpty) return;
    const batchSize = 1;

    setState(() {
      _moqAuditBusy = true;
      _error = null;
      _lastMoqAuditSummary = 'MOQ 검사 준비 중…';
    });

    try {
      final flaggedIds = <String>{};
      var scanned = 0;
      var flagged = 0;
      var skipped = 0;
      var stopped = 0;
      var stopFailed = 0;

      for (var start = 0; start < ids.length; start += batchSize) {
        final end =
            (start + batchSize > ids.length) ? ids.length : start + batchSize;
        final chunk = ids.sublist(start, end);
        if (mounted) {
          setState(() {
            _lastMoqAuditSummary =
                'MOQ 검사 중… ${start + 1}-$end / ${ids.length}';
          });
        }
        final json = await widget.api.postJson('/api/catalog/moq-audit/scan', {
          'ids': chunk,
          'autoStop': true,
        });
        final items = (json['items'] as List?) ?? const [];
        for (final raw in items) {
          if (raw is! Map) continue;
          final item = raw.cast<String, dynamic>();
          if (item['flagged'] == true) {
            final autoStop =
                (item['autoStop'] as Map?)?.cast<String, dynamic>() ??
                    const <String, dynamic>{};
            final product =
                (item['product'] as Map?)?.cast<String, dynamic>() ??
                    const <String, dynamic>{};
            final id = (product['id'] ?? item['id'] ?? '').toString().trim();
            if (id.isNotEmpty && autoStop['ok'] != true) flaggedIds.add(id);
          }
        }
        scanned += int.tryParse((json['scanned'] ?? 0).toString()) ?? 0;
        flagged += int.tryParse((json['flagged'] ?? 0).toString()) ?? 0;
        skipped += int.tryParse((json['skipped'] ?? 0).toString()) ?? 0;
        stopped += int.tryParse((json['autoStopped'] ?? 0).toString()) ?? 0;
        stopFailed +=
            int.tryParse((json['autoStopFailed'] ?? 0).toString()) ?? 0;
      }

      await _refresh(syncRemote: false);
      if (!mounted) return;
      setState(() {
        _lastMoqAuditSummary = 'MOQ 검사: 문제 $flagged건 · 판매중단 $stopped건'
            ' · 중단실패 $stopFailed건 · 스킵 $skipped건 (검사 $scanned건)';
        _selectMode = flaggedIds.isNotEmpty;
        _selected
          ..clear()
          ..addAll(flaggedIds);
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            stopped > 0
                ? 'MOQ 문제 $stopped건을 쿠팡 판매중단 처리했습니다.'
                : flaggedIds.isNotEmpty
                    ? '판매중단 실패 ${flaggedIds.length}건을 선택해 두었습니다.'
                    : '최소 주문수량 문제 상품을 찾지 못했습니다.',
          ),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() => _error = 'MOQ 검사 실패: $e');
    } finally {
      if (mounted) {
        setState(() => _moqAuditBusy = false);
      }
    }
  }

  Future<void> _bulkDeleteRemote() async {
    if (_selected.isEmpty) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('쿠팡 상품 삭제'),
        content: Text(
          '선택한 ${_selected.length}건을 쿠팡 Wing에서도 삭제합니다. 이미 잘못 올라간 상품일 때만 진행하세요.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('취소'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('삭제'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;

    setState(() {
      _loading = true;
      _error = null;
    });

    var okCount = 0;
    var skippedCount = 0;
    var failedCount = 0;

    try {
      for (final id in _selected) {
        if (id.trim().isEmpty) {
          skippedCount += 1;
          continue;
        }
        try {
          await widget.api.postJson('/api/catalog/$id/delete-remote', {});
          okCount += 1;
        } catch (_) {
          failedCount += 1;
        }
      }

      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            '쿠팡 삭제 완료: 성공 $okCount · 스킵 $skippedCount · 실패 $failedCount',
          ),
        ),
      );
      setState(() => _selected.clear());
      await _refresh(syncRemote: false);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  String _defaultMarketingCampaign() {
    final now = DateTime.now();
    final y = now.year.toString();
    final m = now.month.toString().padLeft(2, '0');
    final d = now.day.toString().padLeft(2, '0');
    return 'ig_catalog_$y$m$d';
  }

  String _productTitle(Map<String, dynamic> product) {
    return (product['confirmedTitle'] ?? '').toString().trim();
  }

  String _productSourceUrl(Map<String, dynamic> product) {
    return (product['sourceUrl'] ?? '').toString().trim();
  }

  bool _isCoupangProductUrl(String raw) {
    final url = raw.trim();
    if (!(url.startsWith('http://') || url.startsWith('https://'))) {
      return false;
    }
    final uri = Uri.tryParse(url);
    if (uri == null) return false;
    final host = uri.host.toLowerCase();
    final path = uri.path.toLowerCase();
    return host.contains('coupang.com') && path.contains('/vp/products/');
  }

  String _resolveMarketingTargetUrl(Map<String, dynamic> product) {
    final direct = (product['productUrl'] ?? '').toString().trim();
    if (_isCoupangProductUrl(direct)) {
      return direct;
    }
    final productId = (product['productId'] ?? '').toString().trim();
    if (productId.isNotEmpty) {
      return 'https://www.coupang.com/vp/products/$productId?failRedirectApp=true';
    }
    final sourceUrl = _productSourceUrl(product);
    if (_isCoupangProductUrl(sourceUrl)) {
      return sourceUrl;
    }
    return '';
  }

  bool _canGenerateMarketingOneShot(Map<String, dynamic> product) {
    return _resolveMarketingTargetUrl(product).isNotEmpty &&
        _productSourceUrl(product).isNotEmpty &&
        _productTitle(product).isNotEmpty;
  }

  List<String> _marketingImagesOf(Map<String, dynamic> product) {
    final values = <String>[
      (product['mainImageUrl'] ?? '').toString().trim(),
    ];
    final seen = <String>{};
    final out = <String>[];
    for (final raw in values) {
      final url = raw.trim();
      if (!(url.startsWith('http://') || url.startsWith('https://'))) continue;
      if (seen.add(url)) out.add(url);
    }
    return out;
  }

  Future<void> _copyText(String text, String message) async {
    final value = text.trim();
    if (value.isEmpty) return;
    await Clipboard.setData(ClipboardData(text: value));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message)),
    );
  }

  Future<void> _openExternalUrl(String rawUrl) async {
    final uri = Uri.tryParse(rawUrl);
    if (uri == null) return;
    final launched = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (launched || !mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('열기 실패: $rawUrl')),
    );
  }

  Future<void> _autoPublishInstagramReel(
    Map<String, dynamic> product,
    Map<String, dynamic> json,
  ) async {
    if (!supportsVideoFilePick) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('현재 환경에서는 영상 파일 선택 업로드를 지원하지 않습니다.')),
      );
      return;
    }

    final caption = _instagramCaptionText(product, json).trim();
    if (caption.isEmpty) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('업로드 문안이 없어 자동 업로드를 진행할 수 없습니다.')),
      );
      return;
    }

    PickedVideoFile? picked;
    try {
      picked = await pickVideoFile();
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('영상 파일 읽기 실패: $e')),
      );
      return;
    }
    if (picked == null) return;

    final productId = (product['id'] ?? '').toString().trim();
    if (mounted) {
      setState(() {
        _marketingBusy = true;
        _marketingBusyId = productId;
      });
    }

    try {
      final uploadJson = await widget.api.postBytesJson(
        '/api/instagram/reels/upload',
        picked.bytes,
        query: {'filename': picked.name},
        contentType: picked.mimeType.trim().isEmpty
            ? 'video/mp4'
            : picked.mimeType.trim(),
        extraHeaders: {'X-Filename': picked.name},
      );
      final file = (uploadJson['file'] as Map?)?.cast<String, dynamic>() ??
          const <String, dynamic>{};
      final videoUrl = (file['publicUrl'] ?? '').toString().trim();
      if (videoUrl.isEmpty) {
        throw StateError('instagram_upload_url_missing');
      }

      final publishJson = await widget.api.postJson(
        '/api/instagram/reels/publish',
        {
          'videoUrl': videoUrl,
          'caption': caption,
          'shareToFeed': true,
        },
      );
      final media = (publishJson['media'] as Map?)?.cast<String, dynamic>() ??
          const <String, dynamic>{};
      final permalink = (media['permalink'] ?? '').toString().trim();

      if (!mounted) return;
      await showDialog<void>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: const Text('인스타 자동 업로드 완료'),
          content: SizedBox(
            width: 520,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                CopyableSingleLineRow(
                  k: '업로드 영상',
                  value: (picked?.name ?? '').trim().isEmpty
                      ? '선택한 mp4'
                      : picked!.name,
                ),
                CopyableSingleLineRow(k: '공개 URL', value: videoUrl),
                if (permalink.isNotEmpty)
                  CopyableSingleLineRow(k: '인스타 링크', value: permalink),
              ],
            ),
          ),
          actions: [
            if (permalink.isNotEmpty)
              TextButton.icon(
                onPressed: () => _openExternalUrl(permalink),
                icon: const Icon(Icons.open_in_new_outlined, size: 18),
                label: const Text('게시물 열기'),
              ),
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(),
              child: const Text('닫기'),
            ),
          ],
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('인스타 자동 업로드 실패: $e')),
      );
    } finally {
      if (mounted) {
        setState(() {
          _marketingBusy = false;
          _marketingBusyId = null;
        });
      }
    }
  }

  String _downloadBaseName(Map<String, dynamic> product) {
    final sellerProductId =
        (product['sellerProductId'] ?? '').toString().trim();
    if (sellerProductId.isNotEmpty) return 'coupelephant_$sellerProductId';
    final productId = (product['productId'] ?? '').toString().trim();
    if (productId.isNotEmpty) return 'coupelephant_$productId';
    final id = (product['id'] ?? '').toString().trim();
    if (id.isNotEmpty) return 'coupelephant_$id';
    return 'coupelephant_product';
  }

  String _imageFileExtension(String rawUrl) {
    final parsed = Uri.tryParse(rawUrl);
    final path = parsed?.path.toLowerCase() ?? rawUrl.toLowerCase();
    for (final ext in const ['.jpg', '.jpeg', '.png', '.webp', '.gif']) {
      if (path.endsWith(ext)) return ext;
    }
    return '.jpg';
  }

  String _downloadableImageUrl(String rawUrl, String filename) {
    final baseUri = Uri.parse(widget.api.baseUrl);
    return baseUri.replace(
      path: '/api/image-proxy',
      queryParameters: {
        'url': rawUrl,
        'download': '1',
        'filename': filename,
      },
    ).toString();
  }

  Future<void> _downloadMarketingImages(
    Map<String, dynamic> product,
    List<String> images,
  ) async {
    if (images.isEmpty) return;

    if (!supportsFileDownload) {
      await _copyText(images.join('\n'), '이 환경에서는 사진 URL 목록을 복사했어요.');
      return;
    }

    final base = _downloadBaseName(product);
    final files = <DownloadFileSpec>[];
    for (var i = 0; i < images.length; i += 1) {
      final imageUrl = images[i];
      final index = (i + 1).toString().padLeft(2, '0');
      final filename = '${base}_$index${_imageFileExtension(imageUrl)}';
      files.add(
        DownloadFileSpec(
          url: _downloadableImageUrl(imageUrl, filename),
          filename: filename,
        ),
      );
    }

    final count = await downloadFiles(files);
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(
          count > 0
              ? '사진 $count장을 다운로드 시작했어요. 브라우저가 여러 파일 다운로드를 물으면 허용하세요.'
              : '다운로드를 시작하지 못해 사진 URL 목록을 대신 복사해 주세요.',
        ),
      ),
    );
  }

  List<String> _videoPromptList(Map<String, dynamic> pack) {
    final soraPrompts = _stringList(pack['soraVideoPrompts']);
    if (soraPrompts.isNotEmpty) return soraPrompts;
    return _stringList(pack['grokVideoPrompts']);
  }

  String _soraPromptsText(Map<String, dynamic> json) {
    final rows = (json['items'] as List?) ?? const [];
    final prompts = <String>[];
    for (final raw in rows) {
      if (raw is! Map) continue;
      final row = raw.cast<String, dynamic>();
      final pack = (row['pack'] as Map?)?.cast<String, dynamic>() ??
          const <String, dynamic>{};
      prompts.addAll(_videoPromptList(pack));
    }
    return prompts.join('\n\n---\n\n');
  }

  Map<String, dynamic> _firstMarketingRow(Map<String, dynamic> json) {
    final rows = (json['items'] as List?) ?? const [];
    if (rows.isNotEmpty && rows.first is Map) {
      return (rows.first as Map).cast<String, dynamic>();
    }
    return const <String, dynamic>{};
  }

  Map<String, dynamic> _firstMarketingPack(Map<String, dynamic> json) {
    final row = _firstMarketingRow(json);
    return (row['pack'] as Map?)?.cast<String, dynamic>() ??
        const <String, dynamic>{};
  }

  Map<String, dynamic> _firstMarketingTracking(Map<String, dynamic> json) {
    final row = _firstMarketingRow(json);
    return (row['tracking'] as Map?)?.cast<String, dynamic>() ??
        const <String, dynamic>{};
  }

  List<String> _stringList(dynamic raw) {
    if (raw is! List) return const [];
    return raw
        .map((e) => e.toString().trim())
        .where((e) => e.isNotEmpty)
        .toList();
  }

  String _stringValue(Map<String, dynamic> map, String key) {
    return (map[key] ?? '').toString().trim();
  }

  String _instagramCaptionText(
    Map<String, dynamic> product,
    Map<String, dynamic> json,
  ) {
    final pack = _firstMarketingPack(json);
    final tracking = _firstMarketingTracking(json);
    final oneShot = _stringValue(pack, 'instagramPostText');
    final captions = _stringList(pack['captions']);
    final hashtags = _stringList(pack['hashtags']);
    if (oneShot.isNotEmpty) return oneShot;
    final lines = <String>[];

    if (captions.isNotEmpty) {
      lines.add(captions.first);
    } else if (_productTitle(product).isNotEmpty) {
      lines.add(_productTitle(product));
    }

    if (hashtags.isNotEmpty) {
      lines.add('');
      lines.add(hashtags.join(' '));
    }

    final trackingUrl = (tracking['trackingUrl'] ?? '').toString().trim();
    if (trackingUrl.isNotEmpty) {
      lines.add('');
      lines.add('링크: $trackingUrl');
    }

    return lines.join('\n').trim();
  }

  String _commentCtaText(Map<String, dynamic> json) {
    final pack = _firstMarketingPack(json);
    return _stringValue(pack, 'commentCtaText');
  }

  String _commentReplyTemplateText(Map<String, dynamic> json) {
    final pack = _firstMarketingPack(json);
    return _stringValue(pack, 'commentReplyTemplate');
  }

  String _dmReplyTemplateText(Map<String, dynamic> json) {
    final pack = _firstMarketingPack(json);
    return _stringValue(pack, 'dmReplyTemplate');
  }

  String _pinnedCommentText(Map<String, dynamic> json) {
    final pack = _firstMarketingPack(json);
    return _stringValue(pack, 'pinnedComment');
  }

  String _manychatKeywordText(Map<String, dynamic> json) {
    final pack = _firstMarketingPack(json);
    final keyword = _stringValue(pack, 'manychatTriggerKeyword');
    if (keyword.isNotEmpty) return keyword;
    return _stringValue(pack, 'commentKeyword');
  }

  String _manychatPublicRepliesText(Map<String, dynamic> json) {
    final pack = _firstMarketingPack(json);
    final replies = _stringList(pack['manychatPublicReplies']);
    if (replies.isEmpty) return '';
    final lines = <String>[];
    for (var i = 0; i < replies.length; i += 1) {
      lines.add('${i + 1}. ${replies[i]}');
    }
    return lines.join('\n').trim();
  }

  String _manychatOpeningDmText(Map<String, dynamic> json) {
    final pack = _firstMarketingPack(json);
    final dm = _stringValue(pack, 'manychatOpeningDm');
    if (dm.isNotEmpty) return dm;
    return _stringValue(pack, 'dmReplyTemplate');
  }

  String _manychatButtonLabelText(Map<String, dynamic> json) {
    final pack = _firstMarketingPack(json);
    return _stringValue(pack, 'manychatButtonLabel');
  }

  String _manychatButtonUrlText(Map<String, dynamic> json) {
    final pack = _firstMarketingPack(json);
    final url = _stringValue(pack, 'manychatButtonUrl');
    if (url.isNotEmpty) return url;
    final tracking = _firstMarketingTracking(json);
    return (tracking['trackingUrl'] ?? '').toString().trim();
  }

  String _manychatSetupGuideText(Map<String, dynamic> json) {
    final pack = _firstMarketingPack(json);
    final steps = _stringList(pack['manychatSetupGuide']);
    if (steps.isEmpty) return '';
    final lines = <String>[];
    for (var i = 0; i < steps.length; i += 1) {
      lines.add('${i + 1}. ${steps[i]}');
    }
    return lines.join('\n').trim();
  }

  String _bgmGuideText(Map<String, dynamic> json) {
    final pack = _firstMarketingPack(json);
    final guide = _stringValue(pack, 'bgmGuideText');
    final keywords = _stringList(pack['bgmSearchKeywords']);
    final lines = <String>[];
    if (keywords.isNotEmpty) {
      lines.add('추천 검색어');
      for (var i = 0; i < keywords.length; i += 1) {
        lines.add('${i + 1}. ${keywords[i]}');
      }
    }
    if (guide.isNotEmpty) {
      if (lines.isNotEmpty) lines.add('');
      lines.add('사용 메모');
      lines.add(guide);
    }
    return lines.join('\n').trim();
  }

  String _referenceImageGuideText(Map<String, dynamic> json) {
    final pack = _firstMarketingPack(json);
    final guide = _stringList(pack['referenceImageGuide']);
    if (guide.isEmpty) return '';
    final lines = <String>[];
    for (var i = 0; i < guide.length; i += 1) {
      lines.add('${i + 1}. ${guide[i]}');
    }
    return lines.join('\n').trim();
  }

  String _productFeatureHintsText(Map<String, dynamic> json) {
    final pack = _firstMarketingPack(json);
    final hints = _stringList(pack['productFeatureHints']);
    if (hints.isEmpty) return '';
    final lines = <String>[];
    for (var i = 0; i < hints.length; i += 1) {
      lines.add('${i + 1}. ${hints[i]}');
    }
    return lines.join('\n').trim();
  }

  String _instagramChecklistText(
    Map<String, dynamic> product,
    Map<String, dynamic> json,
  ) {
    final pack = _firstMarketingPack(json);
    final hooks = _stringList(pack['hooks']);
    final tracking = _firstMarketingTracking(json);
    final commentCtaText = _stringValue(pack, 'commentCtaText');
    final hasBgmKeywords = _stringList(pack['bgmSearchKeywords']).isNotEmpty;
    final trackingUrl = (tracking['trackingUrl'] ?? '').toString().trim();

    final lines = <String>[
      '1. 인스타 업로드 문안 복사 버튼으로 메인 문구/본문/해시태그를 한 번에 복사합니다.',
      '2. 메인 이미지와 글씨 없는 디테일 상품컷 1~4장을 고릅니다.',
      '3. 앱에 대표 이미지 1장만 보이면 상품 URL에서 추가 상품 사진을 직접 저장합니다.',
      if (hooks.isNotEmpty) '4. 첫 2초 자막은 "${hooks.first}" 로 시작합니다.',
      if (trackingUrl.isNotEmpty) '5. 프로필 링크에는 $trackingUrl 를 반영합니다.',
      if (commentCtaText.isNotEmpty)
        '6. 게시 후 댓글 유도 문구 "$commentCtaText" 흐름으로 운영합니다.',
      if (hasBgmKeywords) '7. 업로드 직전 추천 검색어로 인스타 음악 라이브러리에서 BGM을 선택합니다.',
      '8. 영상 업로드 후 클릭 수를 확인합니다.',
    ];
    return lines.join('\n');
  }

  Widget _buildOneShotSection(
    BuildContext context, {
    required IconData icon,
    required String title,
    required String subtitle,
    required Widget child,
  }) {
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(14),
        border: Border.all(
          color: Theme.of(context).colorScheme.outline.withValues(alpha: 0.2),
        ),
        color: Theme.of(context)
            .colorScheme
            .surfaceContainerHighest
            .withValues(alpha: 0.28),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Icon(
                icon,
                size: 18,
                color: Theme.of(context).colorScheme.primary,
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: const TextStyle(fontWeight: FontWeight.w800),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      subtitle,
                      style: TextStyle(
                        fontSize: 12,
                        color: Theme.of(context)
                            .colorScheme
                            .onSurface
                            .withValues(alpha: 0.68),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          child,
        ],
      ),
    );
  }

  String _buildMarketingOneShotBundle(
    Map<String, dynamic> product,
    Map<String, dynamic> json,
  ) {
    final row = _firstMarketingRow(json);
    final item = (row['item'] as Map?)?.cast<String, dynamic>() ??
        const <String, dynamic>{};
    final tracking = _firstMarketingTracking(json);
    final pack = _firstMarketingPack(json);
    final hooks = _stringList(pack['hooks']);
    final storyboards = (pack['storyboards'] as List?) ?? const [];
    final firstStoryboard = storyboards.isNotEmpty && storyboards.first is List
        ? (storyboards.first as List)
            .map((e) => e.toString().trim())
            .where((e) => e.isNotEmpty)
            .toList()
        : const <String>[];
    final captions = _stringList(pack['captions']);
    final hashtags = _stringList(pack['hashtags']);
    final thumbnailTexts = _stringList(pack['thumbnailTexts']);
    final prompts = _soraPromptsText(json);
    final images = _marketingImagesOf(product);
    final instagramPostText = _stringValue(pack, 'instagramPostText');
    final commentCtaText = _stringValue(pack, 'commentCtaText');
    final pinnedComment = _stringValue(pack, 'pinnedComment');
    final commentReplyTemplate = _stringValue(pack, 'commentReplyTemplate');
    final dmReplyTemplate = _stringValue(pack, 'dmReplyTemplate');
    final manychatKeyword = _stringValue(pack, 'manychatTriggerKeyword');
    final manychatPublicReplies = _stringList(pack['manychatPublicReplies']);
    final manychatOpeningDm = _stringValue(pack, 'manychatOpeningDm');
    final manychatButtonLabel = _stringValue(pack, 'manychatButtonLabel');
    final manychatButtonUrl = _stringValue(pack, 'manychatButtonUrl');
    final manychatSetupGuide = _stringList(pack['manychatSetupGuide']);
    final bgmGuideText = _bgmGuideText(json);
    final referenceImageGuideText = _referenceImageGuideText(json);
    final productFeatureHintsText = _productFeatureHintsText(json);
    final trackingUrl = (tracking['trackingUrl'] ?? '').toString().trim();
    final targetUrl = (item['targetUrl'] ?? _resolveMarketingTargetUrl(product))
        .toString()
        .trim();
    final lines = <String>[
      '상품명: ${_productTitle(product)}',
      '캠페인: ${(json['campaign'] ?? '').toString().trim()}',
      '톤: ${(json['tone'] ?? '').toString().trim()}',
      if (targetUrl.isNotEmpty) '상품 URL: $targetUrl',
      if (trackingUrl.isNotEmpty) '추적 링크: $trackingUrl',
      if (_productSourceUrl(product).isNotEmpty)
        '원본 URL: ${_productSourceUrl(product)}',
      '',
      '업로드 준비',
      '1. 메인 이미지와 글씨 없는 디테일 상품컷 1~4장을 골라 reference로 사용',
      '2. 상세페이지 전체 캡처, 글씨/가격/규격표, 얼굴 보이는 사람 컷은 제외',
      '3. 첫 2초에 훅 문구 삽입',
      '4. 본문/고정댓글에 추적 링크 반영',
    ];

    if (images.isNotEmpty) {
      lines.add('');
      lines.add('앱 보유 대표 이미지');
      for (var i = 0; i < images.length; i += 1) {
        lines.add('${i + 1}. ${images[i]}');
      }
    }

    if (referenceImageGuideText.isNotEmpty) {
      lines.add('');
      lines.add('Sora 입력 이미지 가이드');
      lines.add(referenceImageGuideText);
    }

    if (productFeatureHintsText.isNotEmpty) {
      lines.add('');
      lines.add('감지된 상품 특징');
      lines.add(productFeatureHintsText);
    }

    if (hooks.isNotEmpty) {
      lines.add('');
      lines.add('훅 후보');
      for (var i = 0; i < hooks.length; i += 1) {
        lines.add('${i + 1}. ${hooks[i]}');
      }
    }

    if (firstStoryboard.isNotEmpty) {
      lines.add('');
      lines.add('권장 장면 구성');
      for (var i = 0; i < firstStoryboard.length; i += 1) {
        lines.add('${i + 1}. ${firstStoryboard[i]}');
      }
    }

    if (captions.isNotEmpty) {
      lines.add('');
      lines.add('인스타 업로드 문안');
      lines.add(
          instagramPostText.isNotEmpty ? instagramPostText : captions.first);
    }

    if (hashtags.isNotEmpty) {
      lines.add('');
      lines.add('해시태그');
      lines.add(hashtags.join(' '));
    }

    if (commentCtaText.isNotEmpty) {
      lines.add('');
      lines.add('댓글 유도 문구');
      lines.add(commentCtaText);
    }

    if (pinnedComment.isNotEmpty) {
      lines.add('');
      lines.add('고정댓글 템플릿');
      lines.add(pinnedComment);
    }

    if (commentReplyTemplate.isNotEmpty) {
      lines.add('');
      lines.add('수동 답글 템플릿');
      lines.add(commentReplyTemplate);
    }

    if (dmReplyTemplate.isNotEmpty) {
      lines.add('');
      lines.add('DM 템플릿');
      lines.add(dmReplyTemplate);
    }

    if (manychatKeyword.isNotEmpty ||
        manychatPublicReplies.isNotEmpty ||
        manychatOpeningDm.isNotEmpty ||
        manychatSetupGuide.isNotEmpty) {
      lines.add('');
      lines.add('Manychat Free 댓글→DM');
      if (manychatKeyword.isNotEmpty) {
        lines.add('트리거 키워드');
        lines.add(manychatKeyword);
      }
      if (manychatPublicReplies.isNotEmpty) {
        lines.add('공개 답글 후보');
        for (var i = 0; i < manychatPublicReplies.length; i += 1) {
          lines.add('${i + 1}. ${manychatPublicReplies[i]}');
        }
      }
      if (manychatOpeningDm.isNotEmpty) {
        lines.add('오프닝 DM');
        lines.add(manychatOpeningDm);
      }
      if (manychatButtonLabel.isNotEmpty || manychatButtonUrl.isNotEmpty) {
        lines.add('DM 버튼');
        lines.add(
            '${manychatButtonLabel.isEmpty ? '구매 링크 보기' : manychatButtonLabel} / ${manychatButtonUrl.isEmpty ? '-' : manychatButtonUrl}');
      }
      if (manychatSetupGuide.isNotEmpty) {
        lines.add('Manychat 설정 순서');
        for (var i = 0; i < manychatSetupGuide.length; i += 1) {
          lines.add('${i + 1}. ${manychatSetupGuide[i]}');
        }
      }
    }

    if (bgmGuideText.isNotEmpty) {
      lines.add('');
      lines.add('추천 BGM');
      lines.add(bgmGuideText);
    }

    if (thumbnailTexts.isNotEmpty) {
      lines.add('');
      lines.add('썸네일 문구');
      for (var i = 0; i < thumbnailTexts.length; i += 1) {
        lines.add('${i + 1}. ${thumbnailTexts[i]}');
      }
    }

    if (prompts.trim().isNotEmpty) {
      lines.add('');
      lines.add('Sora 프롬프트');
      lines.add(prompts.trim());
    }

    return lines.join('\n');
  }

  Future<void> _showMarketingOneShotDialog(
    Map<String, dynamic> product,
    Map<String, dynamic> json,
  ) async {
    final row = _firstMarketingRow(json);
    final item = (row['item'] as Map?)?.cast<String, dynamic>() ??
        const <String, dynamic>{};
    final tracking = _firstMarketingTracking(json);
    final pack = _firstMarketingPack(json);
    final images = _marketingImagesOf(product);
    final bundleText = _buildMarketingOneShotBundle(product, json);
    final prompts = _soraPromptsText(json).trim();
    final promptList = _videoPromptList(pack);
    final trackingUrl = (tracking['trackingUrl'] ?? '').toString().trim();
    final targetUrl = (item['targetUrl'] ?? _resolveMarketingTargetUrl(product))
        .toString()
        .trim();
    final sourceUrl = _productSourceUrl(product);
    final hooks = _stringList(pack['hooks']);
    final captions = _stringList(pack['captions']);
    final hashtags = _stringList(pack['hashtags']);
    final thumbnailTexts = _stringList(pack['thumbnailTexts']);
    final instagramCaption = _instagramCaptionText(product, json);
    final commentCtaText = _commentCtaText(json);
    final commentReplyTemplate = _commentReplyTemplateText(json);
    final dmReplyTemplate = _dmReplyTemplateText(json);
    final pinnedComment = _pinnedCommentText(json);
    final manychatKeyword = _manychatKeywordText(json);
    final manychatPublicReplies = _manychatPublicRepliesText(json);
    final manychatOpeningDm = _manychatOpeningDmText(json);
    final manychatButtonLabel = _manychatButtonLabelText(json);
    final manychatButtonUrl = _manychatButtonUrlText(json);
    final manychatSetupGuide = _manychatSetupGuideText(json);
    final bgmGuideText = _bgmGuideText(json);
    final referenceImageGuideText = _referenceImageGuideText(json);
    final productFeatureHintsText = _productFeatureHintsText(json);
    final instagramChecklist = _instagramChecklistText(product, json);
    final primaryPrompt = promptList.isNotEmpty ? promptList.first : prompts;
    final promptPreview = primaryPrompt.length > 3000
        ? '${primaryPrompt.substring(0, 3000)}\n\n... (생략)'
        : primaryPrompt;

    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('인스타/Sora 원샷'),
        content: SizedBox(
          width: 780,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Sora에는 아래 "대표 프롬프트 복사"만 넣고, 상품 URL/추적 링크/운영 메모 전체 텍스트는 넣지 마세요.',
                  style: TextStyle(
                    fontSize: 12,
                    color: Theme.of(context).colorScheme.error,
                  ),
                ),
                const SizedBox(height: 12),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    FilledButton.tonalIcon(
                      onPressed: primaryPrompt.trim().isEmpty
                          ? null
                          : () async {
                              await _copyText(
                                primaryPrompt,
                                'Sora 프롬프트를 복사했어요.',
                              );
                            },
                      icon: const Icon(Icons.movie_creation_outlined, size: 18),
                      label: const Text('1. Sora 프롬프트 복사'),
                    ),
                    FilledButton.icon(
                      onPressed: instagramCaption.isEmpty
                          ? null
                          : () async {
                              await _copyText(
                                instagramCaption,
                                '인스타 업로드 문안을 복사했어요.',
                              );
                            },
                      icon: const Icon(Icons.copy_all_outlined, size: 18),
                      label: const Text('2. 인스타 업로드 문안 복사'),
                    ),
                    if (commentReplyTemplate.isNotEmpty)
                      OutlinedButton.icon(
                        onPressed: () async {
                          await _copyText(
                            commentReplyTemplate,
                            '댓글 답글 템플릿을 복사했어요.',
                          );
                        },
                        icon: const Icon(Icons.reply_outlined, size: 18),
                        label: const Text('3. 댓글 답글 복사'),
                      ),
                    if (manychatSetupGuide.isNotEmpty)
                      OutlinedButton.icon(
                        onPressed: () async {
                          await _copyText(
                            manychatSetupGuide,
                            'Manychat 설정 순서를 복사했어요.',
                          );
                        },
                        icon: const Icon(Icons.auto_awesome_motion_outlined,
                            size: 18),
                        label: const Text('Manychat 세팅 복사'),
                      ),
                    FilledButton.icon(
                      onPressed: !supportsVideoFilePick || _marketingBusy
                          ? null
                          : () => _autoPublishInstagramReel(product, json),
                      icon: const Icon(Icons.publish_outlined, size: 18),
                      label: const Text('4. 자동 업로드'),
                    ),
                    if (bgmGuideText.isNotEmpty)
                      OutlinedButton.icon(
                        onPressed: () async {
                          await _copyText(
                            bgmGuideText,
                            '추천 BGM 검색어를 복사했어요.',
                          );
                        },
                        icon: const Icon(Icons.music_note_outlined, size: 18),
                        label: const Text('BGM 검색어 복사'),
                      ),
                    if (trackingUrl.isNotEmpty)
                      OutlinedButton.icon(
                        onPressed: () async {
                          await _copyText(trackingUrl, '추적 링크를 복사했어요.');
                        },
                        icon: const Icon(Icons.link, size: 18),
                        label: const Text('추적 링크 복사'),
                      ),
                    if (targetUrl.isNotEmpty)
                      OutlinedButton.icon(
                        onPressed: () => _openExternalUrl(targetUrl),
                        icon: const Icon(Icons.open_in_new_outlined, size: 18),
                        label: const Text('상품 페이지 열기'),
                      ),
                    if (images.isNotEmpty)
                      OutlinedButton.icon(
                        onPressed: () =>
                            _downloadMarketingImages(product, images),
                        icon: const Icon(Icons.download_for_offline_outlined,
                            size: 18),
                        label: Text(
                          supportsFileDownload ? '사진 일괄 다운로드' : '사진 URL 안내',
                        ),
                      ),
                    if (images.isNotEmpty)
                      OutlinedButton.icon(
                        onPressed: () async {
                          await _copyText(
                              images.join('\n'), '사진 URL 목록을 복사했어요.');
                        },
                        icon:
                            const Icon(Icons.photo_library_outlined, size: 18),
                        label: const Text('사진 URL 복사'),
                      ),
                  ],
                ),
                const SizedBox(height: 12),
                _buildOneShotSection(
                  context,
                  icon: Icons.campaign_outlined,
                  title: '1. 인스타 업로드',
                  subtitle: '메인 문구부터 해시태그, 댓글 유도, 답글 템플릿까지 복사해서 바로 쓰는 단계입니다.',
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (_productTitle(product).isNotEmpty)
                        CopyableSingleLineRow(
                          k: '상품명',
                          value: _productTitle(product),
                        ),
                      if (trackingUrl.isNotEmpty)
                        CopyableSingleLineRow(k: '추적 링크', value: trackingUrl),
                      if (targetUrl.isNotEmpty)
                        CopyableSingleLineRow(k: '상품 URL', value: targetUrl),
                      if (sourceUrl.isNotEmpty)
                        CopyableSingleLineRow(k: '원본 URL', value: sourceUrl),
                      const SizedBox(height: 8),
                      if (hooks.isNotEmpty) ...[
                        Text(
                          '추천 첫 문구',
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w800,
                            color: Theme.of(context).colorScheme.onSurface,
                          ),
                        ),
                        const SizedBox(height: 6),
                        SelectableText(
                          hooks.first,
                          style: const TextStyle(fontSize: 12, height: 1.4),
                        ),
                        const SizedBox(height: 8),
                      ],
                      Text(
                        '인스타 업로드 문안',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w800,
                          color: Theme.of(context).colorScheme.onSurface,
                        ),
                      ),
                      const SizedBox(height: 6),
                      SelectableText(
                        instagramCaption.isEmpty
                            ? '생성된 본문이 없습니다.'
                            : instagramCaption,
                        style: const TextStyle(fontSize: 12, height: 1.45),
                      ),
                      if (thumbnailTexts.isNotEmpty) ...[
                        const SizedBox(height: 10),
                        Text(
                          '썸네일 문구',
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w800,
                            color: Theme.of(context).colorScheme.onSurface,
                          ),
                        ),
                        const SizedBox(height: 6),
                        SelectableText(
                          thumbnailTexts.join('\n'),
                          style: const TextStyle(fontSize: 12, height: 1.4),
                        ),
                      ],
                      const SizedBox(height: 10),
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          OutlinedButton.icon(
                            onPressed: instagramCaption.isEmpty
                                ? null
                                : () async {
                                    await _copyText(
                                      instagramCaption,
                                      '인스타 업로드 문안을 복사했어요.',
                                    );
                                  },
                            icon: const Icon(Icons.copy_outlined, size: 18),
                            label: const Text('업로드 문안 복사'),
                          ),
                          if (commentCtaText.isNotEmpty)
                            OutlinedButton.icon(
                              onPressed: () async {
                                await _copyText(
                                  commentCtaText,
                                  '댓글 유도 문구를 복사했어요.',
                                );
                              },
                              icon: const Icon(Icons.chat_bubble_outline,
                                  size: 18),
                              label: const Text('댓글 유도 복사'),
                            ),
                          if (commentReplyTemplate.isNotEmpty)
                            OutlinedButton.icon(
                              onPressed: () async {
                                await _copyText(
                                  commentReplyTemplate,
                                  '댓글 답글 템플릿을 복사했어요.',
                                );
                              },
                              icon: const Icon(Icons.reply_outlined, size: 18),
                              label: const Text('답글 템플릿 복사'),
                            ),
                          if (dmReplyTemplate.isNotEmpty)
                            OutlinedButton.icon(
                              onPressed: () async {
                                await _copyText(
                                  dmReplyTemplate,
                                  'DM 템플릿을 복사했어요.',
                                );
                              },
                              icon: const Icon(Icons.mark_chat_unread_outlined,
                                  size: 18),
                              label: const Text('DM 템플릿 복사'),
                            ),
                          if (thumbnailTexts.isNotEmpty)
                            OutlinedButton.icon(
                              onPressed: () async {
                                await _copyText(
                                  thumbnailTexts.join('\n'),
                                  '썸네일 문구를 복사했어요.',
                                );
                              },
                              icon: const Icon(Icons.title_outlined, size: 18),
                              label: const Text('썸네일 문구 복사'),
                            ),
                          if (trackingUrl.isNotEmpty)
                            OutlinedButton.icon(
                              onPressed: () async {
                                await _copyText(trackingUrl, '추적 링크를 복사했어요.');
                              },
                              icon: const Icon(Icons.link, size: 18),
                              label: const Text('링크 복사'),
                            ),
                        ],
                      ),
                      if (commentCtaText.isNotEmpty) ...[
                        const SizedBox(height: 10),
                        Text(
                          '댓글 유도 문구',
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w800,
                            color: Theme.of(context).colorScheme.onSurface,
                          ),
                        ),
                        const SizedBox(height: 6),
                        SelectableText(
                          commentCtaText,
                          style: const TextStyle(fontSize: 12, height: 1.4),
                        ),
                      ],
                      if (pinnedComment.isNotEmpty) ...[
                        const SizedBox(height: 10),
                        Text(
                          '고정댓글 템플릿',
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w800,
                            color: Theme.of(context).colorScheme.onSurface,
                          ),
                        ),
                        const SizedBox(height: 6),
                        SelectableText(
                          pinnedComment,
                          style: const TextStyle(fontSize: 12, height: 1.4),
                        ),
                      ],
                      if (commentReplyTemplate.isNotEmpty) ...[
                        const SizedBox(height: 10),
                        Text(
                          '수동 댓글 답글 템플릿',
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w800,
                            color: Theme.of(context).colorScheme.onSurface,
                          ),
                        ),
                        const SizedBox(height: 6),
                        SelectableText(
                          commentReplyTemplate,
                          style: const TextStyle(fontSize: 12, height: 1.4),
                        ),
                      ],
                      if (dmReplyTemplate.isNotEmpty) ...[
                        const SizedBox(height: 10),
                        Text(
                          '수동 DM 템플릿',
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w800,
                            color: Theme.of(context).colorScheme.onSurface,
                          ),
                        ),
                        const SizedBox(height: 6),
                        SelectableText(
                          dmReplyTemplate,
                          style: const TextStyle(fontSize: 12, height: 1.4),
                        ),
                      ],
                      if (bgmGuideText.isNotEmpty) ...[
                        const SizedBox(height: 10),
                        Text(
                          '추천 BGM',
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w800,
                            color: Theme.of(context).colorScheme.onSurface,
                          ),
                        ),
                        const SizedBox(height: 6),
                        SelectableText(
                          bgmGuideText,
                          style: const TextStyle(fontSize: 12, height: 1.4),
                        ),
                      ],
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                _buildOneShotSection(
                  context,
                  icon: Icons.chat_bubble_outline,
                  title: '2. Manychat Free 댓글→DM',
                  subtitle:
                      '지금은 Manychat Free로 댓글 트리거와 DM 발송만 운영하고, 나중에 우리 API로 같은 문구를 그대로 바꿔끼울 수 있게 준비한 단계입니다.',
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (manychatKeyword.isNotEmpty)
                        CopyableSingleLineRow(
                          k: '트리거 키워드',
                          value: manychatKeyword,
                        ),
                      if (manychatButtonUrl.isNotEmpty)
                        CopyableSingleLineRow(
                          k: 'DM 버튼 URL',
                          value: manychatButtonUrl,
                        ),
                      if (manychatButtonLabel.isNotEmpty)
                        CopyableSingleLineRow(
                          k: 'DM 버튼 라벨',
                          value: manychatButtonLabel,
                        ),
                      const SizedBox(height: 8),
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          if (manychatKeyword.isNotEmpty)
                            OutlinedButton.icon(
                              onPressed: () async {
                                await _copyText(
                                  manychatKeyword,
                                  'Manychat 트리거 키워드를 복사했어요.',
                                );
                              },
                              icon: const Icon(Icons.tag_outlined, size: 18),
                              label: const Text('키워드 복사'),
                            ),
                          if (manychatPublicReplies.isNotEmpty)
                            OutlinedButton.icon(
                              onPressed: () async {
                                await _copyText(
                                  manychatPublicReplies,
                                  'Manychat 공개 답글 후보를 복사했어요.',
                                );
                              },
                              icon: const Icon(Icons.forum_outlined, size: 18),
                              label: const Text('공개 답글 복사'),
                            ),
                          if (manychatOpeningDm.isNotEmpty)
                            OutlinedButton.icon(
                              onPressed: () async {
                                await _copyText(
                                  manychatOpeningDm,
                                  'Manychat 오프닝 DM을 복사했어요.',
                                );
                              },
                              icon: const Icon(Icons.send_outlined, size: 18),
                              label: const Text('오프닝 DM 복사'),
                            ),
                          if (manychatButtonUrl.isNotEmpty)
                            OutlinedButton.icon(
                              onPressed: () async {
                                await _copyText(
                                  manychatButtonUrl,
                                  'Manychat 버튼 링크를 복사했어요.',
                                );
                              },
                              icon: const Icon(Icons.link_outlined, size: 18),
                              label: const Text('버튼 링크 복사'),
                            ),
                          if (manychatSetupGuide.isNotEmpty)
                            OutlinedButton.icon(
                              onPressed: () async {
                                await _copyText(
                                  manychatSetupGuide,
                                  'Manychat 설정 순서를 복사했어요.',
                                );
                              },
                              icon: const Icon(
                                Icons.checklist_rtl_outlined,
                                size: 18,
                              ),
                              label: const Text('설정 순서 복사'),
                            ),
                        ],
                      ),
                      if (manychatPublicReplies.isNotEmpty) ...[
                        const SizedBox(height: 10),
                        Text(
                          '공개 답글 후보',
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w800,
                            color: Theme.of(context).colorScheme.onSurface,
                          ),
                        ),
                        const SizedBox(height: 6),
                        SelectableText(
                          manychatPublicReplies,
                          style: const TextStyle(fontSize: 12, height: 1.4),
                        ),
                      ],
                      if (manychatOpeningDm.isNotEmpty) ...[
                        const SizedBox(height: 10),
                        Text(
                          '오프닝 DM',
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w800,
                            color: Theme.of(context).colorScheme.onSurface,
                          ),
                        ),
                        const SizedBox(height: 6),
                        SelectableText(
                          manychatOpeningDm,
                          style: const TextStyle(fontSize: 12, height: 1.45),
                        ),
                      ],
                      if (manychatSetupGuide.isNotEmpty) ...[
                        const SizedBox(height: 10),
                        Text(
                          'Manychat 설정 순서',
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w800,
                            color: Theme.of(context).colorScheme.onSurface,
                          ),
                        ),
                        const SizedBox(height: 6),
                        SelectableText(
                          manychatSetupGuide,
                          style: const TextStyle(fontSize: 12, height: 1.45),
                        ),
                      ],
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                _buildOneShotSection(
                  context,
                  icon: Icons.movie_creation_outlined,
                  title: '3. Sora 영상 생성',
                  subtitle:
                      '아래 프롬프트를 Sora에 넣고, 선택한 상품 이미지를 같이 올린 뒤 영상만 받아오면 됩니다.',
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        'Sora 사용 순서',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w800,
                          color: Theme.of(context).colorScheme.onSurface,
                        ),
                      ),
                      const SizedBox(height: 6),
                      SelectableText(
                        [
                          '1. 메인 이미지와 글씨 없는 디테일 상품컷 1~4장을 고릅니다.',
                          '2. 앱에 대표 이미지 1장만 있으면 상품 페이지 열기 버튼으로 이동해 추가 상품 사진을 직접 저장합니다.',
                          '3. 사진 일괄 다운로드 버튼은 앱에 저장된 대표 이미지가 있을 때만 보조용으로 사용합니다.',
                          '4. Sora에 대표 프롬프트를 그대로 붙여 넣습니다.',
                          '5. 저장한 상품 사진을 reference 이미지로 함께 넣습니다.',
                          '6. 세로 9:16, 15~20초 영상으로 생성하고 가장 자연스러운 1개만 채택합니다.',
                          '7. 기본 프롬프트는 얼굴 없음/무자막/무음 기준이므로 그대로 사용합니다.',
                          '8. Sora에는 글씨 많은 상세페이지 캡처, 상품 URL, 추적 링크, 운영 메모 전체 텍스트를 넣지 않습니다.',
                        ].join('\n'),
                        style: const TextStyle(fontSize: 12, height: 1.45),
                      ),
                      if (referenceImageGuideText.isNotEmpty) ...[
                        const SizedBox(height: 10),
                        Text(
                          '입력 이미지 가이드',
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w800,
                            color: Theme.of(context).colorScheme.onSurface,
                          ),
                        ),
                        const SizedBox(height: 6),
                        SelectableText(
                          referenceImageGuideText,
                          style: const TextStyle(fontSize: 12, height: 1.45),
                        ),
                      ],
                      if (productFeatureHintsText.isNotEmpty) ...[
                        const SizedBox(height: 10),
                        Text(
                          '감지된 상품 특징',
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w800,
                            color: Theme.of(context).colorScheme.onSurface,
                          ),
                        ),
                        const SizedBox(height: 6),
                        SelectableText(
                          productFeatureHintsText,
                          style: const TextStyle(fontSize: 12, height: 1.45),
                        ),
                      ],
                      const SizedBox(height: 10),
                      Text(
                        '추천 프롬프트',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w800,
                          color: Theme.of(context).colorScheme.onSurface,
                        ),
                      ),
                      const SizedBox(height: 6),
                      SelectableText(
                        promptPreview.isEmpty
                            ? '생성된 프롬프트가 없습니다.'
                            : promptPreview,
                        style: const TextStyle(fontSize: 12, height: 1.45),
                      ),
                      const SizedBox(height: 10),
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          OutlinedButton.icon(
                            onPressed: primaryPrompt.trim().isEmpty
                                ? null
                                : () async {
                                    await _copyText(
                                      primaryPrompt,
                                      'Sora 프롬프트를 복사했어요.',
                                    );
                                  },
                            icon: const Icon(Icons.copy_outlined, size: 18),
                            label: const Text('대표 프롬프트 복사'),
                          ),
                          if (prompts.isNotEmpty && prompts != primaryPrompt)
                            OutlinedButton.icon(
                              onPressed: () async {
                                await _copyText(
                                  prompts,
                                  '전체 Sora 프롬프트를 복사했어요.',
                                );
                              },
                              icon:
                                  const Icon(Icons.copy_all_outlined, size: 18),
                              label: const Text('전체 프롬프트 복사'),
                            ),
                        ],
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 12),
                _buildOneShotSection(
                  context,
                  icon: Icons.inventory_2_outlined,
                  title: '3. 업로드 재료',
                  subtitle: '사진 선택과 최종 업로드 전 확인 단계입니다.',
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '업로드 순서',
                        style: TextStyle(
                          fontSize: 12,
                          fontWeight: FontWeight.w800,
                          color: Theme.of(context).colorScheme.onSurface,
                        ),
                      ),
                      const SizedBox(height: 6),
                      SelectableText(
                        instagramChecklist,
                        style: const TextStyle(fontSize: 12, height: 1.45),
                      ),
                      if (images.isNotEmpty) ...[
                        const SizedBox(height: 10),
                        Text(
                          '앱 보유 대표 이미지',
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.w800,
                            color: Theme.of(context).colorScheme.onSurface,
                          ),
                        ),
                        const SizedBox(height: 6),
                        SizedBox(
                          height: 78,
                          child: ListView.separated(
                            scrollDirection: Axis.horizontal,
                            itemCount: images.length > 8 ? 8 : images.length,
                            separatorBuilder: (_, __) =>
                                const SizedBox(width: 8),
                            itemBuilder: (ctx, i) {
                              final imageUrl = images[i];
                              return InkWell(
                                onTap: () => _openExternalUrl(imageUrl),
                                borderRadius: BorderRadius.circular(10),
                                child: ClipRRect(
                                  borderRadius: BorderRadius.circular(10),
                                  child: Image.network(
                                    widget.api.proxyImageUrl(imageUrl),
                                    width: 78,
                                    height: 78,
                                    fit: BoxFit.cover,
                                    errorBuilder: (_, __, ___) => Container(
                                      width: 78,
                                      height: 78,
                                      color: Theme.of(context)
                                          .colorScheme
                                          .surfaceContainerHighest,
                                      child: Icon(
                                        Icons.broken_image_outlined,
                                        color: Theme.of(context)
                                            .colorScheme
                                            .onSurface
                                            .withValues(alpha: 0.5),
                                      ),
                                    ),
                                  ),
                                ),
                              );
                            },
                          ),
                        ),
                        const SizedBox(height: 10),
                        OutlinedButton.icon(
                          onPressed: () =>
                              _downloadMarketingImages(product, images),
                          icon: const Icon(Icons.download_for_offline_outlined,
                              size: 18),
                          label: Text(
                            supportsFileDownload
                                ? '대표 이미지 다운로드'
                                : '대표 이미지 URL 안내',
                          ),
                        ),
                        const SizedBox(height: 8),
                        OutlinedButton.icon(
                          onPressed: () async {
                            await _copyText(
                                images.join('\n'), '사진 URL 목록을 복사했어요.');
                          },
                          icon: const Icon(Icons.photo_library_outlined,
                              size: 18),
                          label: const Text('사진 URL 복사'),
                        ),
                        const SizedBox(height: 8),
                        Text(
                          '추가 reference가 필요하면 상품 페이지에서 메인 이미지 캐러셀 사진을 직접 저장해 함께 넣으세요.',
                          style: TextStyle(
                            fontSize: 11,
                            height: 1.4,
                            color: Theme.of(context)
                                .colorScheme
                                .onSurface
                                .withValues(alpha: 0.7),
                          ),
                        ),
                      ],
                      const SizedBox(height: 10),
                      TextButton.icon(
                        onPressed: () async {
                          await _copyText(bundleText, '운영 메모를 복사했어요.');
                        },
                        icon: const Icon(Icons.copy_all_outlined, size: 18),
                        label: const Text('운영 메모 복사'),
                      ),
                    ],
                  ),
                ),
                if (captions.isNotEmpty || hashtags.isNotEmpty) ...[
                  const SizedBox(height: 12),
                  _buildOneShotSection(
                    context,
                    icon: Icons.receipt_long_outlined,
                    title: '참고 자료',
                    subtitle: '필요할 때만 확인하는 보조 정보입니다.',
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        if (captions.isNotEmpty) ...[
                          Text(
                            '대표 캡션 원문',
                            style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w800,
                              color: Theme.of(context).colorScheme.onSurface,
                            ),
                          ),
                          const SizedBox(height: 6),
                          SelectableText(
                            captions.first,
                            style: const TextStyle(fontSize: 12, height: 1.4),
                          ),
                        ],
                        if (hashtags.isNotEmpty) ...[
                          const SizedBox(height: 10),
                          Text(
                            '해시태그',
                            style: TextStyle(
                              fontSize: 12,
                              fontWeight: FontWeight.w800,
                              color: Theme.of(context).colorScheme.onSurface,
                            ),
                          ),
                          const SizedBox(height: 6),
                          SelectableText(
                            hashtags.join(' '),
                            style: const TextStyle(fontSize: 12, height: 1.4),
                          ),
                        ],
                      ],
                    ),
                  ),
                ],
              ],
            ),
          ),
        ),
        actions: [
          TextButton.icon(
            onPressed: () async {
              await _copyText(bundleText, '운영 메모를 복사했어요.');
            },
            icon: const Icon(Icons.copy_all_outlined, size: 18),
            label: const Text('운영 메모 복사'),
          ),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('닫기'),
          ),
        ],
      ),
    );
  }

  Future<void> _generateMarketingOneShot(Map<String, dynamic> product) async {
    final title = _productTitle(product);
    final sourceUrl = _productSourceUrl(product);
    final targetUrl = _resolveMarketingTargetUrl(product);
    final id = (product['id'] ?? '').toString().trim();
    if (title.isEmpty || sourceUrl.isEmpty || targetUrl.isEmpty) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(
          content:
              Text('쿠팡 상품 URL을 아직 찾지 못해 원샷을 만들 수 없습니다. 상태 동기화 후 다시 시도해 주세요.'),
        ),
      );
      return;
    }

    setState(() {
      _marketingBusy = true;
      _marketingBusyId = id;
    });
    try {
      final json = await widget.api.postJson('/api/marketing/reels/pack', {
        'platform': 'instagram',
        'campaign': _defaultMarketingCampaign(),
        'brand': '쿠팡코끼리',
        'tone': '실용적',
        'autoCreateLinks': true,
        'items': [
          {
            'title': title,
            'keyword': '',
            'targetUrl': targetUrl,
            'sourceUrl': sourceUrl,
            'category': '',
            'content': id.isEmpty ? 'catalog_oneshot' : 'catalog_$id',
          },
        ],
      });
      if (!mounted) return;
      await _showMarketingOneShotDialog(product, json);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('마케팅 원샷 생성 실패: $e')),
      );
    } finally {
      if (mounted) {
        setState(() {
          _marketingBusy = false;
          _marketingBusyId = null;
        });
      }
    }
  }

  Widget _thumbPlaceholder(BuildContext context) {
    return Container(
      width: 66,
      height: 66,
      color: Theme.of(context).colorScheme.surfaceContainerHighest,
      child: Icon(
        Icons.image_outlined,
        color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.5),
      ),
    );
  }

  Widget _statusChip(BuildContext context, String value, String label) {
    final active = _status == value;
    final c = active
        ? Theme.of(context).colorScheme.primary
        : Theme.of(context).colorScheme.outline;
    return InkWell(
      borderRadius: BorderRadius.circular(999),
      onTap: _loading
          ? null
          : () {
              setState(() => _status = value);
              _refresh(syncRemote: false);
            },
      child: InfoChip(label: label, color: c),
    );
  }

  String _statusLabel(String raw) {
    final status = raw.trim().toLowerCase();
    switch (status) {
      case 'confirmed':
        return '미업로드';
      case 'uploaded':
        return '업로드완료(조회중)';
      case 'draft_saved':
        return '임시저장';
      case 'pending_approval':
        return '승인대기';
      case 'deployed':
        return '판매중';
      case 'deployed_invalid':
        return '검증 필요';
      case 'deploy_failed':
        return '업로드 실패';
      case 'deleted_remote':
        return '원격 삭제됨';
      case 'deleted_local':
        return '로컬 숨김';
      default:
        return raw.trim().isEmpty ? '-' : raw.trim();
    }
  }

  Color _statusColor(BuildContext context, String raw) {
    final status = raw.trim().toLowerCase();
    if (status == 'deployed') return const Color(0xFF2F9E44); // 판매중
    if (status == 'pending_approval') return const Color(0xFF1971C2);
    if (status == 'draft_saved') return Colors.orange;
    if (status == 'uploaded') return Theme.of(context).colorScheme.primary;
    if (status == 'confirmed') return Theme.of(context).colorScheme.outline;
    if (status == 'deployed_invalid') return Colors.orange;
    if (status == 'deploy_failed') return Theme.of(context).colorScheme.error;
    return Theme.of(context).colorScheme.outline;
  }

  Future<void> _handleCardMenuAction(
    String action,
    String id,
    Map<String, dynamic> product,
  ) async {
    if (action == 'detail') {
      await Navigator.of(context).push(
        MaterialPageRoute(
          builder: (_) => ProductDetailScreen(
            api: widget.api,
            productId: id,
          ),
        ),
      );
      if (mounted) {
        await _refresh(syncRemote: false);
      }
      return;
    }

    if (action == 'marketing') {
      await _generateMarketingOneShot(product);
    }
  }

  @override
  Widget build(BuildContext context) {
    final visibleProducts = _visibleProducts;
    final deployedCount = _products
        .where(
          (p) =>
              (p['status'] ?? '').toString().trim().toLowerCase() == 'deployed',
        )
        .length;
    final pendingApprovalCount = _products
        .where(
          (p) =>
              (p['status'] ?? '').toString().trim().toLowerCase() ==
              'pending_approval',
        )
        .length;
    final reviewCount = _products.where((p) {
      final status = (p['status'] ?? '').toString().trim().toLowerCase();
      return status == 'deployed_invalid' || status == 'deploy_failed';
    }).length;
    final lowPriceCount = _products.where(_isLowPriceFlagged).length;

    return AppScaffold(
      title: _screenTitle,
      onRefresh: _refreshWithStatusSync,
      actions: [
        IconButton(
          onPressed: _loading
              ? null
              : () {
                  setState(() {
                    _selectMode = !_selectMode;
                    _selected.clear();
                  });
                },
          icon: Icon(_selectMode ? Icons.close : Icons.checklist),
        ),
        IconButton(
          onPressed: _loading ? null : _refreshWithStatusSync,
          icon: const Icon(Icons.refresh),
        ),
      ],
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeader('카탈로그 요약'),
                const SizedBox(height: 12),
                Wrap(
                  spacing: 10,
                  runSpacing: 10,
                  children: [
                    _CatalogMetric(
                      title: '판매중',
                      value: '$deployedCount',
                      subtitle: '현재 노출 중',
                    ),
                    _CatalogMetric(
                      title: '승인대기',
                      value: '$pendingApprovalCount',
                      subtitle: 'Wing 승인 대기',
                    ),
                    _CatalogMetric(
                      title: '검증 필요',
                      value: '$reviewCount',
                      subtitle: '실패/예외 상품',
                    ),
                    _CatalogMetric(
                      title: '저가 의심',
                      value: '$lowPriceCount',
                      subtitle: '가격 오파싱 점검',
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SectionHeader(
                  '빠른 작업',
                  trailing: _selectMode
                      ? InfoChip(
                          label: '선택 ${_selected.length}',
                          color: Theme.of(context).colorScheme.primary,
                        )
                      : null,
                ),
                const SizedBox(height: 12),
                Wrap(
                  spacing: 10,
                  runSpacing: 10,
                  children: [
                    FilledButton.tonalIcon(
                      onPressed: _loading ? null : _refreshWithStatusSync,
                      icon: _syncingStatus
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.sync),
                      label: const Text('상태 동기화'),
                    ),
                    FilledButton.tonalIcon(
                      onPressed: _loading || _priceAuditBusy || _moqAuditBusy
                          ? null
                          : _scanLowPriceMisparses,
                      icon: _priceAuditBusy
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.price_check_outlined),
                      label: const Text('저가 검사'),
                    ),
                    FilledButton.tonalIcon(
                      onPressed: _loading || _priceAuditBusy || _moqAuditBusy
                          ? null
                          : _scanMoqIssues,
                      icon: _moqAuditBusy
                          ? const SizedBox(
                              width: 16,
                              height: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.inventory_2_outlined),
                      label: const Text('MOQ 검사+중지'),
                    ),
                    FilledButton.tonalIcon(
                      onPressed: _loading ? null : _importBySellerProductId,
                      icon: const Icon(Icons.playlist_add),
                      label: const Text('기존 상품 가져오기'),
                    ),
                    OutlinedButton.icon(
                      onPressed: _loading
                          ? null
                          : () {
                              setState(() {
                                _selectMode = !_selectMode;
                                _selected.clear();
                              });
                            },
                      icon: Icon(_selectMode ? Icons.close : Icons.checklist),
                      label: Text(_selectMode ? '선택 종료' : '선택 작업'),
                    ),
                    OutlinedButton.icon(
                      onPressed: _loading
                          ? null
                          : () {
                              setState(() {
                                _recoveryOnly = !_recoveryOnly;
                                if (!_recoveryOnly) {
                                  _lowPriceOnly = false;
                                }
                                _selected.clear();
                              });
                            },
                      icon: Icon(
                        _recoveryOnly
                            ? Icons.assignment_turned_in
                            : Icons.assignment_turned_in_outlined,
                      ),
                      label: Text(_recoveryOnly ? '복구 모드' : '복구 큐'),
                    ),
                    OutlinedButton.icon(
                      onPressed: _loading
                          ? null
                          : () {
                              setState(() {
                                _lowPriceOnly = !_lowPriceOnly;
                                if (_lowPriceOnly) {
                                  _recoveryOnly = true;
                                }
                                _selected.clear();
                              });
                            },
                      icon: Icon(
                        _lowPriceOnly
                            ? Icons.price_check
                            : Icons.price_check_outlined,
                      ),
                      label: Text(_lowPriceOnly ? '저가만 보기' : '저가 의심'),
                    ),
                  ],
                ),
                if (_selectMode) ...[
                  const SizedBox(height: 12),
                  Wrap(
                    spacing: 10,
                    runSpacing: 10,
                    children: [
                      TextButton(
                        onPressed: _loading ? null : _selectAllVisible,
                        child: const Text('전체선택'),
                      ),
                      TextButton(
                        onPressed: _loading ? null : _selectFlaggedVisible,
                        child: const Text('문제만 선택'),
                      ),
                      TextButton(
                        onPressed: _loading || _selected.isEmpty
                            ? null
                            : _clearSelection,
                        child: const Text('선택해제'),
                      ),
                      TextButton(
                        onPressed:
                            _loading || _selected.isEmpty ? null : _bulkSync,
                        child: const Text('동기화'),
                      ),
                      TextButton(
                        onPressed: _loading || _selected.isEmpty
                            ? null
                            : _bulkRedeploy,
                        child: const Text('재배포'),
                      ),
                      TextButton(
                        onPressed:
                            _loading || _selected.isEmpty ? null : _bulkArchive,
                        child: const Text('삭제'),
                      ),
                      TextButton(
                        onPressed: _loading || _selected.isEmpty
                            ? null
                            : _bulkDeleteRemote,
                        child: const Text('쿠팡 삭제'),
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _q,
            onSubmitted: (_) => _refresh(syncRemote: false),
            decoration: InputDecoration(
              labelText: '검색 (제목/URL)',
              border: const OutlineInputBorder(),
              suffixIcon: IconButton(
                icon: const Icon(Icons.search),
                onPressed: _loading ? null : () => _refresh(syncRemote: false),
              ),
            ),
          ),
          const SizedBox(height: 10),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: [
                _statusChip(context, '', '전체'),
                const SizedBox(width: 8),
                _statusChip(context, 'confirmed', _statusLabel('confirmed')),
                const SizedBox(width: 8),
                _statusChip(context, 'uploaded', _statusLabel('uploaded')),
                const SizedBox(width: 8),
                _statusChip(
                    context, 'draft_saved', _statusLabel('draft_saved')),
                const SizedBox(width: 8),
                _statusChip(context, 'pending_approval',
                    _statusLabel('pending_approval')),
                const SizedBox(width: 8),
                _statusChip(context, 'deployed', _statusLabel('deployed')),
                const SizedBox(width: 8),
                _statusChip(
                  context,
                  'deployed_invalid',
                  _statusLabel('deployed_invalid'),
                ),
                const SizedBox(width: 8),
                _statusChip(
                  context,
                  'deploy_failed',
                  _statusLabel('deploy_failed'),
                ),
              ],
            ),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              InfoChip(
                label: _loading
                    ? '불러오는 중…'
                    : _recoveryOnly || _lowPriceOnly
                        ? '보이는 ${visibleProducts.length}개'
                        : '총 ${_products.length}개',
                color: Theme.of(context).colorScheme.primary,
              ),
              const SizedBox(width: 8),
              if (_syncingStatus)
                InfoChip(
                  label: '상태 동기화 중…',
                  color: Theme.of(context).colorScheme.tertiary,
                ),
              if (_recoveryOnly) ...[
                const SizedBox(width: 8),
                const InfoChip(
                  label: '복구 큐',
                  color: Color(0xFFE67700),
                ),
              ],
              if (_lowPriceOnly) ...[
                const SizedBox(width: 8),
                const InfoChip(
                  label: '저가 의심만',
                  color: Color(0xFFC92A2A),
                ),
              ],
            ],
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            ErrorBanner(message: _error!, onRetry: _refreshWithStatusSync),
          ],
          if ((_lastSyncSummary ?? '').trim().isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              _lastSyncSummary!,
              style: TextStyle(
                fontSize: 12,
                color: Theme.of(context)
                    .colorScheme
                    .onSurface
                    .withValues(alpha: 0.65),
              ),
            ),
          ],
          if ((_lastPriceAuditSummary ?? '').trim().isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              _lastPriceAuditSummary!,
              style: TextStyle(
                fontSize: 12,
                color: Theme.of(context)
                    .colorScheme
                    .onSurface
                .withValues(alpha: 0.65),
              ),
            ),
          ],
          if ((_lastMoqAuditSummary ?? '').trim().isNotEmpty) ...[
            const SizedBox(height: 4),
            Text(
              _lastMoqAuditSummary!,
              style: TextStyle(
                fontSize: 12,
                color: Theme.of(context)
                    .colorScheme
                    .onSurface
                    .withValues(alpha: 0.65),
              ),
            ),
          ],
          const SizedBox(height: 12),
          if (visibleProducts.isEmpty && !_loading)
            AppCard(
              child: Text(
                _recoveryOnly
                    ? '지금 복구가 필요한 상품이 없습니다. 저가 의심, 업로드 실패, 검증 필요 상품이 생기면 여기서 바로 정리할 수 있어요.'
                    : '아직 확정된 상품이 없어요. 업로드 탭에서 미리보기 → 업로드 실행 후, 빠른 작업의 기존 상품 가져오기로 기존 쿠팡 상품도 불러올 수 있어요.',
                style: TextStyle(
                  color: Theme.of(
                    context,
                  ).colorScheme.onSurface.withValues(alpha: 0.7),
                ),
              ),
            )
          else
            ListView.separated(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              itemCount: visibleProducts.length,
              separatorBuilder: (_, __) => const SizedBox(height: 10),
              itemBuilder: (ctx, i) {
                final p = visibleProducts[i];
                final id = (p['id'] ?? '').toString();
                final title = (p['confirmedTitle'] ?? '').toString();
                final status = (p['status'] ?? '').toString();
                final remoteStatusName =
                    (p['remoteStatusName'] ?? '').toString().trim();
                final img = (p['mainImageUrl'] ?? '').toString();
                final sellerProductId = (p['sellerProductId'] ?? '').toString();
                final selected = _selected.contains(id);
                final canGenerateOneShot = _canGenerateMarketingOneShot(p);
                final marketingBusy = _marketingBusy && _marketingBusyId == id;
                final lowPriceFlagged = _isLowPriceFlagged(p);
                final priceAuditSummary = _priceAuditSummaryLine(p);
                final moqFlagged = _isMoqFlagged(p);
                final minimumOrderQty = _minimumOrderQtyOf(p);
                final moqSummary = _moqSummaryLine(p);

                return AppCard(
                  onTap: id.isEmpty
                      ? null
                      : () async {
                          if (_selectMode) {
                            setState(() {
                              if (selected) {
                                _selected.remove(id);
                              } else {
                                _selected.add(id);
                              }
                            });
                            return;
                          }

                          await Navigator.of(context).push(
                            MaterialPageRoute(
                              builder: (_) => ProductDetailScreen(
                                api: widget.api,
                                productId: id,
                              ),
                            ),
                          );
                          if (mounted) await _refresh(syncRemote: false);
                        },
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      if (_selectMode)
                        Padding(
                          padding: const EdgeInsets.only(right: 10, top: 4),
                          child: Checkbox(
                            value: selected,
                            onChanged: id.isEmpty
                                ? null
                                : (v) {
                                    setState(() {
                                      if (v == true) {
                                        _selected.add(id);
                                      } else {
                                        _selected.remove(id);
                                      }
                                    });
                                  },
                          ),
                        ),
                      ClipRRect(
                        borderRadius: BorderRadius.circular(10),
                        child: img.isEmpty
                            ? _thumbPlaceholder(context)
                            : Image.network(
                                widget.api.proxyImageUrl(img),
                                width: 66,
                                height: 66,
                                fit: BoxFit.cover,
                                errorBuilder: (_, __, ___) =>
                                    _thumbPlaceholder(context),
                              ),
                      ),
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
                                fontWeight: FontWeight.w900,
                              ),
                            ),
                            const SizedBox(height: 6),
                            Wrap(
                              spacing: 8,
                              runSpacing: 6,
                              children: [
                                InfoChip(
                                  label: _statusLabel(status),
                                  color: _statusColor(context, status),
                                ),
                                if (sellerProductId.isNotEmpty)
                                  InfoChip(
                                    label: 'SPID $sellerProductId',
                                    color: const Color(0xFF2F9E44),
                                  ),
                                if (lowPriceFlagged)
                                  const InfoChip(
                                    label: '저가 의심',
                                    color: Color(0xFFC92A2A),
                                  ),
                                if (moqFlagged)
                                  InfoChip(
                                    label: 'MOQ $minimumOrderQty+',
                                    color: const Color(0xFFC92A2A),
                                  ),
                              ],
                            ),
                            if (remoteStatusName.isNotEmpty &&
                                remoteStatusName != _statusLabel(status)) ...[
                              const SizedBox(height: 6),
                              Text(
                                'Wing 상태: $remoteStatusName',
                                style: TextStyle(
                                  fontSize: 12,
                                  color: Theme.of(context)
                                      .colorScheme
                                      .onSurface
                                      .withValues(alpha: 0.68),
                                ),
                              ),
                            ],
                            if (priceAuditSummary.isNotEmpty) ...[
                              const SizedBox(height: 6),
                              Text(
                                priceAuditSummary,
                                style: TextStyle(
                                  fontSize: 12,
                                  color: lowPriceFlagged
                                      ? const Color(0xFFC92A2A)
                                      : Theme.of(context)
                                          .colorScheme
                                          .onSurface
                                          .withValues(alpha: 0.68),
                                ),
                              ),
                            ],
                            if (moqSummary.isNotEmpty) ...[
                              const SizedBox(height: 6),
                              Text(
                                moqSummary,
                                style: const TextStyle(
                                  fontSize: 12,
                                  color: Color(0xFFC92A2A),
                                ),
                              ),
                            ],
                            const SizedBox(height: 8),
                            Row(
                              children: [
                                TextButton.icon(
                                  onPressed: id.isEmpty || _loading
                                      ? null
                                      : () => _handleCardMenuAction(
                                            'detail',
                                            id,
                                            p,
                                          ),
                                  icon: const Icon(Icons.open_in_new, size: 18),
                                  label: const Text('상세'),
                                ),
                                const Spacer(),
                                PopupMenuButton<String>(
                                  enabled: !_loading,
                                  onSelected: (value) async {
                                    await _handleCardMenuAction(value, id, p);
                                  },
                                  itemBuilder: (context) => [
                                    const PopupMenuItem<String>(
                                      value: 'detail',
                                      child: Text('상세 열기'),
                                    ),
                                    PopupMenuItem<String>(
                                      value: 'marketing',
                                      enabled:
                                          !marketingBusy && canGenerateOneShot,
                                      child: Row(
                                        children: [
                                          if (marketingBusy) ...[
                                            const SizedBox(
                                              width: 14,
                                              height: 14,
                                              child: CircularProgressIndicator(
                                                strokeWidth: 2,
                                              ),
                                            ),
                                            const SizedBox(width: 8),
                                          ],
                                          const Text('인스타/Sora 원샷'),
                                        ],
                                      ),
                                    ),
                                  ],
                                  child: Padding(
                                    padding: const EdgeInsets.symmetric(
                                      horizontal: 6,
                                      vertical: 4,
                                    ),
                                    child: Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        Icon(
                                          Icons.more_horiz,
                                          size: 18,
                                          color: Theme.of(context)
                                              .colorScheme
                                              .onSurface
                                              .withValues(alpha: 0.7),
                                        ),
                                        const SizedBox(width: 4),
                                        Text(
                                          '더보기',
                                          style: TextStyle(
                                            color: Theme.of(context)
                                                .colorScheme
                                                .onSurface
                                                .withValues(alpha: 0.72),
                                          ),
                                        ),
                                      ],
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                );
              },
            ),
        ],
      ),
    );
  }
}

class _CatalogMetric extends StatelessWidget {
  const _CatalogMetric({
    required this.title,
    required this.value,
    required this.subtitle,
  });

  final String title;
  final String value;
  final String subtitle;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Container(
      width: 150,
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: cs.primary.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: TextStyle(
              fontSize: 12,
              fontWeight: FontWeight.w700,
              color: cs.onSurface.withValues(alpha: 0.68),
            ),
          ),
          const SizedBox(height: 6),
          Text(
            value,
            style: const TextStyle(fontSize: 22, fontWeight: FontWeight.w900),
          ),
          const SizedBox(height: 4),
          Text(
            subtitle,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              fontSize: 12,
              color: cs.onSurface.withValues(alpha: 0.62),
            ),
          ),
        ],
      ),
    );
  }
}
