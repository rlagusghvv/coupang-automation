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

  final _q = TextEditingController();
  String _status = '';
  bool _selectMode = false;
  final Set<String> _selected = {};

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  @override
  void dispose() {
    _q.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final json = await widget.api.getJson('/api/catalog', query: {
        'limit': '200',
        if (_status.trim().isNotEmpty) 'status': _status.trim(),
        if (_q.text.trim().isNotEmpty) 'q': _q.text.trim(),
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

  Future<void> _bulkSync() async {
    if (_selected.isEmpty) return;
    setState(() => _loading = true);
    try {
      for (final id in _selected) {
        await widget.api.postJson('/api/catalog/$id/sync', {});
      }
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('동기화 ${_selected.length}건 실행했어요.')),
        );
      }
      await _refresh();
    } catch (e) {
      setState(() => _error = e.toString());
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
      await _refresh();
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
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
              _refresh();
            },
      child: InfoChip(label: label, color: c),
    );
  }

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: _selectMode ? '내 상품(선택 ${_selected.length})' : '내 상품',
      onRefresh: _refresh,
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
          onPressed: _loading ? null : _refresh,
          icon: const Icon(Icons.refresh),
        ),
      ],
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextField(
            controller: _q,
            onSubmitted: (_) => _refresh(),
            decoration: InputDecoration(
              labelText: '검색 (제목/URL)',
              border: const OutlineInputBorder(),
              suffixIcon: IconButton(
                icon: const Icon(Icons.search),
                onPressed: _loading ? null : _refresh,
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
                _statusChip(context, 'confirmed', 'confirmed'),
                const SizedBox(width: 8),
                _statusChip(context, 'deployed', 'deployed'),
                const SizedBox(width: 8),
                _statusChip(context, 'deployed_invalid', 'invalid'),
                const SizedBox(width: 8),
                _statusChip(context, 'deploy_failed', 'failed'),
              ],
            ),
          ),
          const SizedBox(height: 10),
          Row(
            children: [
              InfoChip(
                label: _loading ? '불러오는 중…' : '총 ${_products.length}개',
                color: Theme.of(context).colorScheme.primary,
              ),
              const Spacer(),
              if (_selectMode) ...[
                TextButton(
                  onPressed: _loading || _selected.isEmpty ? null : _bulkSync,
                  child: const Text('동기화'),
                ),
                TextButton(
                  onPressed: _loading || _selected.isEmpty ? null : _bulkRedeploy,
                  child: const Text('재배포'),
                ),
              ],
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
                  final selected = _selected.contains(id);

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
                            if (mounted) await _refresh();
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
