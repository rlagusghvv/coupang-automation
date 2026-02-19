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
  });

  final ApiClient api;
  final String sourceUrl;
  final String title;
  final String thumbUrl;
  final String qcTier;
  final int detailImageCount;

  @override
  State<RecommendationDetailScreen> createState() =>
      _RecommendationDetailScreenState();
}

class _RecommendationDetailScreenState
    extends State<RecommendationDetailScreen> {
  bool _loading = false;
  String? _error;
  Map<String, dynamic>? _preview;

  @override
  void initState() {
    super.initState();
    _loadPreview();
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
      setState(
          () => _preview = (json['preview'] as Map?)?.cast<String, dynamic>());
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
            force ? '강제 재업로드로 진행할까요? (중복이어도 새 상품으로 다시 올립니다)' : '업로드를 실행할까요?'),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text('취소')),
          FilledButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('실행')),
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

      if (!mounted) return;

      if (sellerProductId.isNotEmpty) {
        final productUrl =
            'https://www.coupang.com/vp/products/$sellerProductId';
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('업로드 완료!')),
        );
        final u = Uri.tryParse(productUrl);
        if (u != null) {
          // best-effort open
          await launchUrl(u, mode: LaunchMode.externalApplication)
              .catchError((_) => false);
        }
      } else {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
              content: Text('업로드 요청은 성공했지만 상품 ID를 못 받았어요. 로그를 확인하세요.')),
        );
      }
    } on ApiException catch (e) {
      // Duplicate case: show a force option
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
                  child: const Text('취소')),
              FilledButton(
                  onPressed: () => Navigator.of(ctx).pop(true),
                  child: const Text('강제 재업로드')),
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
    final computed = (p['computed'] as Map?)?.cast<String, dynamic>() ?? {};

    final title = (draft['title'] ?? widget.title).toString();
    final sourcePrice = draft['price'];
    final finalPrice = computed['finalPrice'];
    final shippingFee = draft['shippingFee'];
    final shippingPolicy = computed['shippingPolicy'];

    final imagesRaw = (computed['images'] as List?) ?? const [];
    final images = imagesRaw
        .map((e) => e.toString())
        .where((s) => s.trim().isNotEmpty)
        .toList();

    return AppScaffold(
      title: '미리보기',
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
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              child: Text(_error!, style: const TextStyle(color: Colors.red)),
            ),
          Row(
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(12),
                child: SizedBox(
                  width: 72,
                  height: 72,
                  child: widget.thumbUrl.trim().isEmpty
                      ? Container(color: Colors.black12)
                      : Image.network(widget.api.proxyImageUrl(widget.thumbUrl),
                          fit: BoxFit.cover),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(title,
                        style: const TextStyle(fontWeight: FontWeight.w700)),
                    const SizedBox(height: 6),
                    Wrap(
                      spacing: 8,
                      runSpacing: 6,
                      children: [
                        Chip(label: Text('등급 ${widget.qcTier}')),
                        Chip(label: Text('상세 ${widget.detailImageCount}장')),
                      ],
                    ),
                  ],
                ),
              )
            ],
          ),
          const SizedBox(height: 16),
          const SizedBox(height: 12),
          const SectionHeader('가격/배송'),
          const SizedBox(height: 8),
          AppCard(
            child: Column(
              children: [
                KvRow(k: '원가', v: sourcePrice?.toString() ?? '-'),
                KvRow(k: '판매가(계산)', v: finalPrice?.toString() ?? '-'),
                KvRow(k: '배송비(소스)', v: shippingFee?.toString() ?? '-'),
                KvRow(k: '배송정책', v: shippingPolicy?.toString() ?? '-'),
              ],
            ),
          ),
          const SizedBox(height: 12),
          SectionHeader('이미지 (${images.length})'),
          const SizedBox(height: 8),
          AppCard(
            padding: const EdgeInsets.all(12),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (images.isEmpty) const Text('이미지가 없어요.'),
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
                      return ClipRRect(
                        borderRadius: BorderRadius.circular(10),
                        child: Image.network(
                          widget.api.proxyImageUrl(u),
                          fit: BoxFit.cover,
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
        ],
      ),
    );
  }
}
