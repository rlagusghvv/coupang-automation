import 'package:couplus_mobile/api/api_client.dart';
import 'package:couplus_mobile/ui/widgets.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

class RecommendationDetailScreen extends StatefulWidget {
  const RecommendationDetailScreen({
    super.key,
    required this.api,
    required this.sourceUrl,
    required this.title,
    required this.thumbUrl,
    required this.qcTier,
    required this.detailImageCount,
    this.seed,
  });

  final ApiClient api;
  final String sourceUrl;
  final String title;
  final String thumbUrl;
  final String qcTier;
  final int detailImageCount;
  final Map<String, dynamic>? seed;

  @override
  State<RecommendationDetailScreen> createState() =>
      _RecommendationDetailScreenState();
}

class _RecommendationDetailScreenState
    extends State<RecommendationDetailScreen> {
  bool _loading = false;
  String? _error;
  Map<String, dynamic>? _preview;
  Map<String, dynamic>? _qc;
  Map<String, dynamic>? _duplicate;

  @override
  void initState() {
    super.initState();
    _loadPreview();
  }

  Map<String, dynamic> get _seed =>
      (widget.seed ?? const <String, dynamic>{}).cast<String, dynamic>();

  double? _num(dynamic value) {
    if (value == null) return null;
    return double.tryParse(value.toString());
  }

  String _comma(int n) {
    final text = n.toString();
    return text.replaceAllMapped(
      RegExp(r'\B(?=(\d{3})+(?!\d))'),
      (_) => ',',
    );
  }

  String _won(dynamic value) {
    final n = _num(value);
    if (n == null) return '-';
    return '${_comma(n.round())}원';
  }

  String _margin(dynamic value) {
    final n = _num(value);
    if (n == null) return '-';
    return '${(n * 100).toStringAsFixed(0)}%';
  }

  String _humanizeQcMetricPercent(dynamic value) {
    final n = _num(value);
    if (n == null) return '-';
    return '${(n * 100).toStringAsFixed(0)}%';
  }

  List<String> _seedImages() {
    final raw = (_seed['previewImages'] as List?) ?? const [];
    return raw
        .map((e) => e.toString().trim())
        .where((s) => s.isNotEmpty)
        .toList();
  }

  List<String> _httpImageList(dynamic raw) {
    if (raw is! List) return const [];
    final out = <String>[];
    for (final item in raw) {
      final url = item.toString().trim();
      if (url.isEmpty) continue;
      final uri = Uri.tryParse(url);
      if (uri == null) continue;
      if (uri.scheme != 'http' && uri.scheme != 'https') continue;
      out.add(url);
    }
    return out;
  }

  List<String> _uniqueUrls(Iterable<String> urls) {
    final seen = <String>{};
    final out = <String>[];
    for (final raw in urls) {
      final url = raw.trim();
      if (url.isEmpty) continue;
      if (seen.add(url)) out.add(url);
    }
    return out;
  }

  Future<void> _openImageDialog(String imageUrl) async {
    await showDialog<void>(
      context: context,
      barrierColor: Colors.black87,
      builder: (ctx) => Dialog(
        backgroundColor: const Color(0xFF0B1220),
        insetPadding: const EdgeInsets.all(12),
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 1100, maxHeight: 920),
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 8, 6, 4),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        '원본 이미지 미리보기',
                        style: TextStyle(
                          color: Theme.of(context).colorScheme.onSurface,
                          fontWeight: FontWeight.w800,
                        ),
                      ),
                    ),
                    IconButton(
                      onPressed: () => Navigator.of(ctx).pop(),
                      icon: const Icon(Icons.close),
                      tooltip: '닫기',
                    ),
                  ],
                ),
              ),
              const Divider(height: 1),
              Expanded(
                child: InteractiveViewer(
                  minScale: 0.5,
                  maxScale: 6,
                  child: Container(
                    width: double.infinity,
                    alignment: Alignment.center,
                    color: Colors.black,
                    child: Image.network(
                      widget.api.proxyImageUrl(imageUrl),
                      fit: BoxFit.contain,
                      errorBuilder: (_, __, ___) => const Padding(
                        padding: EdgeInsets.all(16),
                        child: Text('이미지를 불러오지 못했습니다.'),
                      ),
                    ),
                  ),
                ),
              ),
              const Divider(height: 1),
              Padding(
                padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        imageUrl,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontSize: 12,
                          color: Theme.of(context)
                              .colorScheme
                              .onSurface
                              .withValues(alpha: 0.75),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    OutlinedButton.icon(
                      onPressed: () async {
                        final uri = Uri.tryParse(imageUrl);
                        if (uri == null) return;
                        await launchUrl(
                          uri,
                          mode: LaunchMode.externalApplication,
                        );
                      },
                      icon: const Icon(Icons.open_in_new, size: 16),
                      label: const Text('원본 열기'),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _loadPreview() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final json = await widget.api.postJson('/api/upload/preview', {
        'url': widget.sourceUrl,
      });
      setState(() {
        _preview = (json['preview'] as Map?)?.cast<String, dynamic>();
        _qc = (json['qc'] as Map?)?.cast<String, dynamic>();
        _duplicate = (json['duplicate'] as Map?)?.cast<String, dynamic>();
      });
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _executeUpload({required bool force}) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('쿠팡 업로드 실행'),
        content: Text(
          force ? '강제 재업로드로 진행할까요? (중복이어도 새 상품으로 다시 올립니다)' : '업로드를 실행할까요?',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: const Text('취소'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(ctx).pop(true),
            child: const Text('실행'),
          ),
        ],
      ),
    );
    if (ok != true) return;

    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final json = await widget.api.postJson('/api/upload/execute', {
        'url': widget.sourceUrl,
        'force': force ? '1' : '0',
      });

      final result = (json['result'] as Map?)?.cast<String, dynamic>() ?? {};
      final create = (result['create'] as Map?)?.cast<String, dynamic>() ?? {};
      final sellerProductId = (create['sellerProductId'] ?? '').toString();
      final followUp =
          (result['followUp'] as Map?)?.cast<String, dynamic>() ?? {};
      final productId = (followUp['productId'] ?? '').toString().trim();
      var productUrl = (followUp['productUrl'] ?? '').toString().trim();
      if (productUrl.isEmpty && productId.isNotEmpty) {
        productUrl =
            'https://www.coupang.com/vp/products/$productId?failRedirectApp=true';
      }

      if (!mounted) return;

      if (sellerProductId.isNotEmpty || productUrl.isNotEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('업로드 완료!')),
        );
        if (productUrl.isNotEmpty) {
          final u = Uri.tryParse(productUrl);
          if (u != null) {
            await launchUrl(u, mode: LaunchMode.externalApplication)
                .catchError((_) => false);
          }
        }
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('업로드 요청은 성공했지만 상품 ID를 못 받았어요. 로그를 확인하세요.'),
          ),
        );
      }
    } on ApiException catch (e) {
      if (e.message == 'duplicate_product') {
        if (!mounted) return;
        final again = await showDialog<bool>(
          context: context,
          builder: (ctx) => AlertDialog(
            title: const Text('이미 업로드된 상품'),
            content: const Text('중복 상품이에요. 강제 재업로드로 다시 올릴까요?'),
            actions: [
              TextButton(
                onPressed: () => Navigator.of(ctx).pop(false),
                child: const Text('취소'),
              ),
              FilledButton(
                onPressed: () => Navigator.of(ctx).pop(true),
                child: const Text('강제 재업로드'),
              ),
            ],
          ),
        );
        if (again == true) {
          await _executeUpload(force: true);
          return;
        }
      }
      setState(() => _error = e.toString());
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = _preview ?? {};
    final draft = (p['draft'] as Map?)?.cast<String, dynamic>() ?? {};
    final inspect = (p['preview'] as Map?)?.cast<String, dynamic>() ?? {};
    final computed = (p['computed'] as Map?)?.cast<String, dynamic>() ?? {};
    final qc = _qc ?? const <String, dynamic>{};
    final qcReasons = ((qc['reasons'] as List?) ?? const [])
        .map((e) => e.toString().trim())
        .where((s) => s.isNotEmpty)
        .toList();
    final qcMetrics =
        (qc['metrics'] as Map?)?.cast<String, dynamic>() ?? const {};
    final qcOk = qc['ok'] == true;
    final duplicate = (_duplicate?['duplicate'] == true);

    final title =
        (draft['title'] ?? _seed['title'] ?? widget.title).toString().trim();
    final sourcePrice = draft['price'] ?? _seed['sourcePrice'];
    final finalPrice = computed['finalPrice'] ?? _seed['finalPrice'];
    final shippingFee = draft['shippingFee'] ?? _seed['shippingFee'];
    final shippingPolicy = (computed['shippingPolicy'] ?? '-').toString();
    final profit = _seed['profit'];
    final marginRate = _seed['marginRate'];

    final filteredDetailImages =
        _httpImageList(inspect['contentImagesFiltered']);
    final rawDetailImages = _httpImageList(inspect['contentImagesRaw']);
    final computedImages = _httpImageList(computed['images']);
    final seedImages = _seedImages();

    final mainImageCandidate =
        (draft['imageUrl'] ?? _seed['mainImageUrl'] ?? widget.thumbUrl)
            .toString()
            .trim();
    final leadImage = mainImageCandidate.isNotEmpty
        ? mainImageCandidate
        : (computedImages.isNotEmpty ? computedImages.first : '');

    final mergedImages = _uniqueUrls([
      ...filteredDetailImages,
      ...rawDetailImages,
      ...seedImages,
      ...computedImages,
    ]);
    final images = mergedImages.where((u) => u != leadImage).toList();

    final detailImageCount = images.isNotEmpty
        ? images.length
        : (int.tryParse((qcMetrics['imageCountFiltered'] ??
                    _seed['contentImageCount'] ??
                    widget.detailImageCount)
                .toString()) ??
            widget.detailImageCount);

    return AppScaffold(
      title: '추천 상세',
      onRefresh: _loadPreview,
      actions: [
        IconButton(
          onPressed: _loading
              ? null
              : () {
                  final u = Uri.tryParse(widget.sourceUrl);
                  if (u != null) {
                    launchUrl(u, mode: LaunchMode.externalApplication);
                  }
                },
          icon: const Icon(Icons.open_in_new),
          tooltip: '원문 열기',
        ),
      ],
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (_error != null) ...[
            ErrorBanner(message: _error!, onRetry: _loadPreview),
            const SizedBox(height: 12),
          ],
          AppCard(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                ClipRRect(
                  borderRadius: BorderRadius.circular(12),
                  child: SizedBox(
                    width: 78,
                    height: 78,
                    child: leadImage.isEmpty
                        ? Container(color: Colors.black12)
                        : Image.network(
                            widget.api.proxyImageUrl(leadImage),
                            fit: BoxFit.cover,
                            errorBuilder: (_, __, ___) =>
                                Container(color: Colors.black12),
                          ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        title.isEmpty ? '(제목 없음)' : title,
                        style: const TextStyle(
                          fontWeight: FontWeight.w900,
                          fontSize: 16,
                        ),
                      ),
                      const SizedBox(height: 8),
                      Wrap(
                        spacing: 8,
                        runSpacing: 6,
                        children: [
                          InfoChip(label: '추천등급 ${widget.qcTier}'),
                          InfoChip(label: '상세 ${detailImageCount.toString()}장'),
                          InfoChip(
                            label: qc.isEmpty
                                ? 'QC 점검 중'
                                : (qcOk ? 'QC 통과' : 'QC 실패'),
                            color: qc.isEmpty || qcOk
                                ? const Color(0xFF2F9E44)
                                : Colors.redAccent,
                          ),
                          if (duplicate)
                            const InfoChip(
                              label: '중복 감지',
                              color: Colors.orange,
                            ),
                        ],
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeader('가격/수익'),
                const SizedBox(height: 8),
                KvRow(k: '원가', v: _won(sourcePrice)),
                KvRow(k: '판매가(계산)', v: _won(finalPrice)),
                KvRow(k: '배송비(소스)', v: _won(shippingFee)),
                KvRow(k: '순마진', v: _won(profit)),
                KvRow(k: '마진율', v: _margin(marginRate)),
                KvRow(k: '배송정책', v: shippingPolicy),
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeader('QC 점검 결과'),
                const SizedBox(height: 8),
                Text(
                  qc.isEmpty
                      ? '업로드 전 QC 정보를 불러오는 중입니다.'
                      : (qcOk
                          ? '통과: 현재 설정 기준에서 자동 업로드 가능한 상태입니다.'
                          : '실패: 현재 설정에서는 업로드가 스킵됩니다.'),
                  style: TextStyle(
                    color: qc.isEmpty || qcOk
                        ? Theme.of(context)
                            .colorScheme
                            .onSurface
                            .withValues(alpha: 0.8)
                        : Theme.of(context).colorScheme.error,
                    fontWeight: FontWeight.w700,
                  ),
                ),
                if (qcReasons.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  ...qcReasons.map(
                    (r) => Padding(
                      padding: const EdgeInsets.only(bottom: 4),
                      child: Text(
                        '• $r',
                        style: TextStyle(
                          color: Theme.of(context)
                              .colorScheme
                              .onSurface
                              .withValues(alpha: 0.8),
                        ),
                      ),
                    ),
                  ),
                ],
                if (qcMetrics.isNotEmpty) ...[
                  const SizedBox(height: 8),
                  Wrap(
                    spacing: 8,
                    runSpacing: 6,
                    children: [
                      InfoChip(
                        label:
                            '필터통과 ${(qcMetrics['imageCountFiltered'] ?? 0).toString()}장',
                      ),
                      InfoChip(
                        label:
                            '차단율 ${_humanizeQcMetricPercent(qcMetrics['rejectedRate'])}',
                      ),
                      InfoChip(
                        label:
                            '토큰일치 ${_humanizeQcMetricPercent(qcMetrics['tokenMatchRate'])}',
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            padding: const EdgeInsets.all(12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SectionHeader('이미지 (${images.length})'),
                const SizedBox(height: 8),
                Text(
                  '필터 ${filteredDetailImages.length}장 · 원본 ${rawDetailImages.length}장 (탭해서 원본 보기)',
                  style: TextStyle(
                    fontSize: 12,
                    color: Theme.of(context)
                        .colorScheme
                        .onSurface
                        .withValues(alpha: 0.7),
                  ),
                ),
                const SizedBox(height: 8),
                if (images.isEmpty)
                  Text(
                    '이미지 파싱 결과가 비어 있습니다. 원문에서 직접 확인해 주세요.',
                    style: TextStyle(
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: 0.75),
                    ),
                  ),
                if (images.isNotEmpty)
                  GridView.builder(
                    shrinkWrap: true,
                    physics: const NeverScrollableScrollPhysics(),
                    gridDelegate:
                        const SliverGridDelegateWithFixedCrossAxisCount(
                      crossAxisCount: 3,
                      crossAxisSpacing: 8,
                      mainAxisSpacing: 8,
                    ),
                    itemCount: images.length,
                    itemBuilder: (ctx, i) {
                      final u = images[i];
                      return Material(
                        color: Colors.transparent,
                        child: InkWell(
                          borderRadius: BorderRadius.circular(10),
                          onTap: () => _openImageDialog(u),
                          child: ClipRRect(
                            borderRadius: BorderRadius.circular(10),
                            child: Stack(
                              fit: StackFit.expand,
                              children: [
                                Container(color: Colors.black12),
                                Image.network(
                                  widget.api.proxyImageUrl(u),
                                  fit: BoxFit.contain,
                                  errorBuilder: (_, __, ___) =>
                                      Container(color: Colors.black12),
                                ),
                                Positioned(
                                  right: 6,
                                  bottom: 6,
                                  child: Container(
                                    padding: const EdgeInsets.all(4),
                                    decoration: BoxDecoration(
                                      color:
                                          Colors.black.withValues(alpha: 0.5),
                                      borderRadius: BorderRadius.circular(6),
                                    ),
                                    child: const Icon(
                                      Icons.zoom_in,
                                      size: 16,
                                      color: Colors.white,
                                    ),
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ),
                      );
                    },
                  ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: FilledButton(
                  onPressed:
                      _loading ? null : () => _executeUpload(force: false),
                  child: _loading ? const Text('처리 중…') : const Text('쿠팡 업로드'),
                ),
              ),
              const SizedBox(width: 12),
              OutlinedButton(
                onPressed: _loading ? null : () => _executeUpload(force: true),
                child: const Text('강제 재업로드'),
              ),
            ],
          ),
          if (!qcOk && qc.isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              '참고: 현재 정책에서는 QC 실패 시 업로드가 자동으로 스킵됩니다.',
              style: TextStyle(
                fontSize: 12,
                color: Theme.of(context)
                    .colorScheme
                    .onSurface
                    .withValues(alpha: 0.65),
              ),
            ),
          ],
        ],
      ),
    );
  }
}
