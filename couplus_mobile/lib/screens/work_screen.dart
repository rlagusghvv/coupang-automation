import 'package:couplus_mobile/api/api_client.dart';
import 'package:couplus_mobile/ui/widgets.dart';
import 'package:flutter/material.dart';

class WorkScreen extends StatefulWidget {
  const WorkScreen({super.key, required this.api});

  final ApiClient api;

  @override
  State<WorkScreen> createState() => _WorkScreenState();
}

class _WorkScreenState extends State<WorkScreen> {
  List<dynamic> _history = const [];
  String? _error;
  bool _loading = false;

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
      final json = await widget.api.getJson('/api/dashboard', query: {'previewLimit': '50'});
      final list = (json['previewHistory'] as List?) ?? const [];
      setState(() => _history = list);
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
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
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SectionHeader('Recent previews', trailing: InfoChip(label: '${_history.length}')),
                const SizedBox(height: 10),
                if (_history.isEmpty)
                  Text(
                    '아직 히스토리가 없어요. 웹에서 미리보기를 실행한 뒤 다시 확인해보세요.',
                    style: TextStyle(color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.65)),
                  )
                else
                  ListView.separated(
                    shrinkWrap: true,
                    physics: const NeverScrollableScrollPhysics(),
                    itemCount: _history.length,
                    separatorBuilder: (_, __) => const Divider(height: 18),
                    itemBuilder: (context, i) {
                      final item = _history[i] as Map? ?? {};
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
