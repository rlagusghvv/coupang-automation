import 'package:couplus_mobile/ui/widgets.dart';
import 'package:flutter/material.dart';

class PreviewDetailScreen extends StatelessWidget {
  const PreviewDetailScreen({
    super.key,
    required this.url,
    required this.preview,
  });

  final String url;
  final Map<String, dynamic> preview;

  @override
  Widget build(BuildContext context) {
    final draft = (preview['draft'] as Map?)?.cast<String, dynamic>() ?? {};
    final computed =
        (preview['computed'] as Map?)?.cast<String, dynamic>() ?? {};
    final options = (preview['options'] as List?) ?? const [];

    final title = (draft['title'] ?? '').toString();
    final imageUrl = (draft['imageUrl'] ?? '').toString();
    final finalPrice = computed['finalPrice'];

    return AppScaffold(
      title: '미리보기 상세',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeader('상품'),
                const SizedBox(height: 10),
                if (imageUrl.isNotEmpty)
                  ClipRRect(
                    borderRadius: BorderRadius.circular(14),
                    child: AspectRatio(
                      aspectRatio: 16 / 9,
                      child: Image.network(
                        imageUrl,
                        fit: BoxFit.cover,
                        errorBuilder: (_, __, ___) => Container(
                          color: Theme.of(context)
                              .colorScheme
                              .surfaceContainerHighest,
                          child: const Center(
                              child: Icon(Icons.image_not_supported)),
                        ),
                      ),
                    ),
                  )
                else
                  Container(
                    height: 140,
                    decoration: BoxDecoration(
                      color:
                          Theme.of(context).colorScheme.surfaceContainerHighest,
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: const Center(child: Icon(Icons.image)),
                  ),
                const SizedBox(height: 12),
                Text(
                  title.isEmpty ? '(제목 없음)' : title,
                  style: Theme.of(context)
                      .textTheme
                      .titleLarge
                      ?.copyWith(fontWeight: FontWeight.w900),
                ),
                const SizedBox(height: 8),
                KvRow(k: '원본 URL', v: url),
                KvRow(k: '최종가', v: (finalPrice ?? '-').toString()),
                KvRow(k: '옵션 개수', v: options.length.toString()),
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SectionHeader(
                  '옵션',
                  trailing: InfoChip(label: '${options.length}개'),
                ),
                const SizedBox(height: 10),
                if (options.isEmpty)
                  Text(
                    '옵션이 없습니다.',
                    style: TextStyle(
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: 0.65),
                    ),
                  )
                else
                  ...options.take(60).map((it) {
                    final o = (it as Map?)?.cast<String, dynamic>() ?? {};
                    final name =
                        (o['name'] ?? o['optionName'] ?? '').toString();
                    final price =
                        (o['price'] ?? o['salePrice'] ?? '').toString();
                    final stock =
                        (o['stock'] ?? o['inventory'] ?? '').toString();
                    return Padding(
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            name.isEmpty ? '(옵션)' : name,
                            style: const TextStyle(fontWeight: FontWeight.w800),
                          ),
                          const SizedBox(height: 4),
                          Text(
                            '가격: ${price.isEmpty ? '-' : price} · 재고: ${stock.isEmpty ? '-' : stock}',
                            style: TextStyle(
                              fontSize: 12,
                              color: Theme.of(context)
                                  .colorScheme
                                  .onSurface
                                  .withValues(alpha: 0.65),
                            ),
                          ),
                        ],
                      ),
                    );
                  }),
                if (options.length > 60) ...[
                  const Divider(height: 24),
                  Text(
                    '옵션이 너무 많아서 일부만 표시했어요. (${options.length}개 중 60개 표시)',
                    style: TextStyle(
                      fontSize: 12,
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: 0.65),
                    ),
                  ),
                ]
              ],
            ),
          ),
        ],
      ),
    );
  }
}
