import 'package:couplus_mobile/api/api_client.dart';
import 'package:couplus_mobile/ui/widgets.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

class RecommendationsScreen extends StatefulWidget {
  const RecommendationsScreen({super.key, required this.api});

  final ApiClient api;

  @override
  State<RecommendationsScreen> createState() => _RecommendationsScreenState();
}

class _RecommendationsScreenState extends State<RecommendationsScreen> {
  bool _loading = false;
  String? _error;
  List<Map<String, dynamic>> _items = const [];

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
      final json = await widget.api.getJson('/api/recommendations', query: {
        'limit': '50',
      });
      final list = (json['items'] as List?) ?? const [];
      setState(() => _items = list.map((e) => (e as Map).cast<String, dynamic>()).toList());
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _runNow() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      await widget.api.postJson('/api/recommendations/run', {'topN': 20});
      await _refresh();
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: '추천',
      onRefresh: _refresh,
      actions: [
        IconButton(
          onPressed: _loading ? null : _runNow,
          icon: const Icon(Icons.play_arrow),
          tooltip: '지금 추천 생성',
        ),
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
                label: _loading ? '불러오는 중…' : '총 ${_items.length}개',
                color: Theme.of(context).colorScheme.primary,
              ),
              const Spacer(),
              Text(
                '기준: 순마진≥3,000원 / 마진율≥30%',
                style: TextStyle(
                  color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.6),
                  fontSize: 12,
                ),
              ),
            ],
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            ErrorBanner(message: _error!, onRetry: _refresh),
          ],
          const SizedBox(height: 12),
          if (_items.isEmpty && !_loading)
            AppCard(
              child: Text(
                '아직 추천이 없어요. 우측 상단 ▶︎ 버튼으로 지금 생성할 수 있어요. (매일 오전 9시에 자동 생성됩니다)',
                style: TextStyle(
                  color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.7),
                ),
              ),
            )
          else
            ListView.separated(
              shrinkWrap: true,
              physics: const NeverScrollableScrollPhysics(),
              itemCount: _items.length,
              separatorBuilder: (_, __) => const SizedBox(height: 10),
              itemBuilder: (ctx, i) {
                final it = _items[i];
                final title = (it['title'] ?? '').toString();
                final img = (it['mainImageUrl'] ?? '').toString();
                final keyword = (it['keyword'] ?? '').toString();
                final profit = (it['profit'] ?? 0);
                final marginRate = (it['marginRate'] ?? 0);
                final finalPrice = (it['finalPrice'] ?? 0);
                final reason = (it['reason'] ?? '').toString();
                final url = (it['sourceUrl'] ?? '').toString();

                return AppCard(
                  onTap: url.isEmpty
                      ? null
                      : () {
                          // For now: copy URL.
                          Clipboard.setData(ClipboardData(text: url));
                          ScaffoldMessenger.of(context).showSnackBar(
                            const SnackBar(content: Text('URL을 복사했어요.')),
                          );
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
                                color: Theme.of(context).colorScheme.surfaceContainerHighest,
                                child: Icon(Icons.image_outlined,
                                    color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.5)),
                              )
                            : Image.network(
                                widget.api.proxyImageUrl(img),
                                width: 66,
                                height: 66,
                                fit: BoxFit.cover,
                                errorBuilder: (_, __, ___) => Container(
                                  width: 66,
                                  height: 66,
                                  color: Theme.of(context).colorScheme.surfaceContainerHighest,
                                  child: Icon(Icons.broken_image,
                                      color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.5)),
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
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(fontWeight: FontWeight.w900),
                            ),
                            const SizedBox(height: 6),
                            Wrap(
                              spacing: 8,
                              runSpacing: 6,
                              children: [
                                if (keyword.isNotEmpty)
                                  InfoChip(
                                    label: keyword,
                                    color: Theme.of(context).colorScheme.outline,
                                  ),
                                InfoChip(
                                  label: '판매가 ${(finalPrice as num).round()}',
                                  color: Theme.of(context).colorScheme.primary,
                                ),
                                InfoChip(
                                  label: '순마진 ${(profit as num).round()}',
                                  color: const Color(0xFF2F9E44),
                                ),
                                InfoChip(
                                  label: '마진 ${(((marginRate as num)) * 100).round()}%',
                                  color: const Color(0xFF2F9E44),
                                ),
                              ],
                            ),
                            if (reason.isNotEmpty) ...[
                              const SizedBox(height: 6),
                              Text(
                                reason,
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.6),
                                  fontSize: 12,
                                ),
                              ),
                            ],
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
