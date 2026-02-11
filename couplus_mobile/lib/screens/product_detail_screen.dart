import 'dart:convert';

import 'package:couplus_mobile/api/api_client.dart';
import 'package:couplus_mobile/screens/catalog_events_screen.dart';
import 'package:couplus_mobile/screens/image_edit_screen.dart';
import 'package:couplus_mobile/screens/image_viewer_screen.dart';
import 'package:couplus_mobile/ui/widgets.dart';
import 'package:couplus_mobile/ui/app_button.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

class ProductDetailScreen extends StatefulWidget {
  const ProductDetailScreen(
      {super.key, required this.api, required this.productId});

  final ApiClient api;
  final String productId;

  @override
  State<ProductDetailScreen> createState() => _ProductDetailScreenState();
}

class _ProductDetailScreenState extends State<ProductDetailScreen> {
  bool _loading = false;
  String? _error;
  Map<String, dynamic>? _product;

  final _title = TextEditingController();
  final _category = TextEditingController();
  String? _presetId;
  final _preset = TextEditingController();
  List<String> _detailImages = const [];

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  @override
  void dispose() {
    _title.dispose();
    _category.dispose();
    _preset.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final json = await widget.api.getJson('/api/catalog/${widget.productId}');
      final p = (json['product'] as Map?)?.cast<String, dynamic>();
      if (p == null) throw Exception('product missing');

      final imgsRaw = (p['detailImages'] as List?) ?? const [];
      final imgs = imgsRaw
          .map((e) => e.toString())
          .where((s) => s.trim().isNotEmpty)
          .toList();

      setState(() {
        _product = p;
        _title.text = (p['confirmedTitle'] ?? '').toString();
        _presetId = (p['presetId'] ?? '').toString().trim().isEmpty
            ? null
            : (p['presetId'] ?? '').toString();
        _preset.text = _presetId ?? '';
        _category.text = (p['categoryOverride'] ?? '').toString();
        _detailImages = imgs;
      });
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _save() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final cat = int.tryParse(_category.text.trim());

      final json =
          await widget.api.postJson('/api/catalog/${widget.productId}', {
        'confirmedTitle': _title.text.trim(),
        'presetId':
            (_presetId ?? '').trim().isEmpty ? null : (_presetId ?? '').trim(),
        'categoryOverride': cat,
        'detailImages': _detailImages,
        if (_detailImages.isNotEmpty)
          'mainImageUrl': _detailImages.first, // simple default
      });

      final p = (json['product'] as Map?)?.cast<String, dynamic>();
      setState(() => _product = p);

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('저장했어요.')),
        );
      }
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _editImages() async {
    final next = await Navigator.of(context).push<List<String>>(
      MaterialPageRoute(
        builder: (_) => ImageEditScreen(
          title: '상세 이미지 편집',
          initial: _detailImages,
          all: _detailImages,
          mapUrl: widget.api.proxyImageUrl,
        ),
      ),
    );

    if (next != null && mounted) {
      setState(() => _detailImages = next);
    }
  }

  Future<void> _deploy() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final json = await widget.api
          .postJson('/api/catalog/${widget.productId}/deploy', {});
      final job = (json['job'] as Map?)?.cast<String, dynamic>();
      final jobId = (job?['id'] ?? '').toString();

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
              content:
                  Text(jobId.isEmpty ? '배포를 시작했어요.' : '배포 시작: job $jobId')),
        );
      }

      await _refresh();
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = _product;
    final sourceUrl = (p?['sourceUrl'] ?? '').toString();
    final sellerProductId = (p?['sellerProductId'] ?? '').toString();
    final status = (p?['status'] ?? '').toString();
    final validation = (p?['validation'] as Map?)?.cast<String, dynamic>();

    String validationText = '';
    if (validation != null && validation.isNotEmpty) {
      validationText = const JsonEncoder.withIndent('  ').convert(validation);
    }

    return AppScaffold(
      title: '상품 편집',
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
          if (_error != null) ErrorBanner(message: _error!, onRetry: _refresh),
          if (_error != null) const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SectionHeader(
                  '메타',
                  trailing: TextButton(
                    onPressed: _loading
                        ? null
                        : () {
                            Navigator.of(context).push(
                              MaterialPageRoute(
                                builder: (_) => CatalogEventsScreen(
                                  api: widget.api,
                                  catalogId: widget.productId,
                                  title: '이벤트',
                                ),
                              ),
                            );
                          },
                    child: const Text('이벤트'),
                  ),
                ),
                const SizedBox(height: 10),
                KvRow(k: '상태', v: status.isEmpty ? '-' : status),
                CopyableSingleLineRow(k: 'ID', value: widget.productId),
                if (sourceUrl.isNotEmpty)
                  CopyableSingleLineRow(k: '원본 URL', value: sourceUrl),
                if (sellerProductId.isNotEmpty)
                  CopyableSingleLineRow(
                      k: 'SellerProductId', value: sellerProductId),
                if (sellerProductId.isNotEmpty)
                  TextButton(
                    onPressed: () async {
                      final uri = Uri.tryParse(
                          'https://www.coupang.com/vp/products/$sellerProductId?failRedirectApp=true');
                      if (uri != null) {
                        await launchUrl(uri,
                            mode: LaunchMode.platformDefault);
                      }
                    },
                    child: const Text('쿠팡 상품 열기'),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeader('확정 내용'),
                const SizedBox(height: 10),
                TextField(
                  controller: _title,
                  decoration: const InputDecoration(
                    labelText: '확정 제목',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: _category,
                  keyboardType: TextInputType.number,
                  decoration: const InputDecoration(
                    labelText: '카테고리 Override (displayCategoryCode)',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 10),
                TextField(
                  controller: _preset,
                  onChanged: (v) =>
                      _presetId = v.trim().isEmpty ? null : v.trim(),
                  decoration: const InputDecoration(
                    labelText: 'Preset ID (선택)',
                    border: OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                Row(
                  children: [
                    Expanded(
                      child: AppButton(
                        onPressed: _loading ? null : _save,
                        label: '저장',
                      ),
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: AppButton(
                        onPressed: _loading ? null : _deploy,
                        label: '배포(업로드)',
                        color: const Color(0xFF2F9E44),
                      ),
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
                const SectionHeader('상세 이미지'),
                const SizedBox(height: 10),
                Row(
                  children: [
                    Text('총 ${_detailImages.length}장'),
                    const Spacer(),
                    TextButton(
                      onPressed: _loading ? null : _editImages,
                      child: const Text('편집'),
                    ),
                    TextButton(
                      onPressed: _detailImages.isEmpty
                          ? null
                          : () {
                              Navigator.of(context).push(
                                MaterialPageRoute(
                                  builder: (_) => ImageViewerScreen(
                                    title: '상세 이미지',
                                    images: _detailImages,
                                    mapUrl: widget.api.proxyImageUrl,
                                  ),
                                ),
                              );
                            },
                      child: const Text('보기'),
                    ),
                  ],
                ),
                if (_detailImages.isEmpty)
                  Text(
                    '상세 이미지가 비어있어요. (배포 후 검증에서 실패할 수 있어요)',
                    style: TextStyle(
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: 0.7),
                    ),
                  ),
              ],
            ),
          ),
          if (validationText.isNotEmpty) ...[
            const SizedBox(height: 12),
            AppCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  const SectionHeader('검증 결과'),
                  const SizedBox(height: 10),
                  Text(
                    validationText,
                    style: TextStyle(
                      fontFamily: 'monospace',
                      fontSize: 12,
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: 0.8),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ],
      ),
    );
  }
}
