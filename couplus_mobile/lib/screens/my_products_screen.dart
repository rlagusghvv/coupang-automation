import 'package:couplus_mobile/api/api_client.dart';
import 'package:couplus_mobile/screens/product_detail_screen.dart';
import 'package:couplus_mobile/ui/widgets.dart';
import 'package:flutter/material.dart';

class MyProductsScreen extends StatefulWidget {
  const MyProductsScreen({super.key, required this.api});

  final ApiClient api;

  @override
  State<MyProductsScreen> createState() => _MyProductsScreenState();
}

class _MyProductsScreenState extends State<MyProductsScreen> {
  bool _loading = false;
  String? _error;
  List<Map<String, dynamic>> _products = const [];

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final json = await widget.api.getJson('/api/catalog', query: {
        'limit': '200',
      });
      final list = (json['products'] as List?) ?? const [];
      setState(() {
        _products =
            list.map((e) => (e as Map).cast<String, dynamic>()).toList();
      });
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: '내 상품',
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
          Row(
            children: [
              InfoChip(
                label: _loading ? '불러오는 중…' : '총 ${_products.length}개',
                color: Theme.of(context).colorScheme.primary,
              ),
            ],
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            ErrorBanner(message: _error!, onRetry: _refresh),
          ],
          const SizedBox(height: 12),
          if (_products.isEmpty && !_loading)
            AppCard(
              child: Text(
                '아직 확정된 상품이 없어요. 작업 탭에서 미리보기 → 업로드 실행을 하면 자동으로 저장됩니다.',
                style: TextStyle(
                  color: Theme.of(context)
                      .colorScheme
                      .onSurface
                      .withValues(alpha: 0.7),
                ),
              ),
            )
          else
            Expanded(
              child: ListView.separated(
                itemCount: _products.length,
                separatorBuilder: (_, __) => const SizedBox(height: 10),
                itemBuilder: (ctx, i) {
                  final p = _products[i];
                  final id = (p['id'] ?? '').toString();
                  final title = (p['confirmedTitle'] ?? '').toString();
                  final status = (p['status'] ?? '').toString();
                  final img = (p['mainImageUrl'] ?? '').toString();
                  final sellerProductId =
                      (p['sellerProductId'] ?? '').toString();

                  return AppCard(
                    onTap: id.isEmpty
                        ? null
                        : () async {
                            await Navigator.of(context).push(
                              MaterialPageRoute(
                                builder: (_) => ProductDetailScreen(
                                  api: widget.api,
                                  productId: id,
                                ),
                              ),
                            );
                            if (mounted) await _refresh();
                          },
                    child: Row(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        ClipRRect(
                          borderRadius: BorderRadius.circular(10),
                          child: img.isEmpty
                              ? Container(
                                  width: 66,
                                  height: 66,
                                  color: Theme.of(context)
                                      .colorScheme
                                      .surfaceContainerHighest,
                                  child: Icon(
                                    Icons.image_outlined,
                                    color: Theme.of(context)
                                        .colorScheme
                                        .onSurface
                                        .withValues(alpha: 0.5),
                                  ),
                                )
                              : Image.network(
                                  img,
                                  width: 66,
                                  height: 66,
                                  fit: BoxFit.cover,
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
                                    label: status.isEmpty ? '-' : status,
                                    color:
                                        Theme.of(context).colorScheme.primary,
                                  ),
                                  if (sellerProductId.isNotEmpty)
                                    InfoChip(
                                      label: 'SPID $sellerProductId',
                                      color: const Color(0xFF2F9E44),
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
            ),
        ],
      ),
    );
  }
}
