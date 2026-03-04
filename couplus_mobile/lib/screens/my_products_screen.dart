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
      if (mounted) setState(() => _loading = false);
    }
  }

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

      await _refresh();
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
      await _refresh();
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
      await _refresh();
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _selectAllVisible() {
    final ids = _products
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
              _refresh();
            },
      child: InfoChip(label: label, color: c),
    );
  }

  String _statusLabel(String raw) {
    final status = raw.trim().toLowerCase();
    switch (status) {
      case 'confirmed':
        return '확정';
      case 'uploaded':
        return '상품 업로드 완료!';
      case 'deployed':
        return '판매중';
      case 'deployed_invalid':
        return '검증 필요';
      case 'deploy_failed':
        return '배포 실패';
      case 'deleted_remote':
        return '원격 삭제됨';
      case 'deleted_local':
        return '로컬 숨김';
      default:
        return raw.trim().isEmpty ? '-' : raw.trim();
    }
  }

  @override
  Widget build(BuildContext context) {
    return AppScaffold(
      title: _selectMode ? '내 상품(선택 ${_selected.length})' : '내 상품',
      onRefresh: _refresh,
      actions: [
        IconButton(
          onPressed: _loading ? null : _importBySellerProductId,
          tooltip: '기존 상품 가져오기',
          icon: const Icon(Icons.playlist_add),
        ),
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
                _statusChip(context, 'confirmed', _statusLabel('confirmed')),
                const SizedBox(width: 8),
                _statusChip(context, 'uploaded', _statusLabel('uploaded')),
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
                label: _loading ? '불러오는 중…' : '총 ${_products.length}개',
                color: Theme.of(context).colorScheme.primary,
              ),
              const Spacer(),
              if (_selectMode) ...[
                TextButton(
                  onPressed: _loading ? null : _selectAllVisible,
                  child: const Text('전체선택'),
                ),
                TextButton(
                  onPressed:
                      _loading || _selected.isEmpty ? null : _clearSelection,
                  child: const Text('선택해제'),
                ),
                TextButton(
                  onPressed:
                      _loading || _selected.isEmpty ? null : _bulkArchive,
                  child: const Text('삭제'),
                ),
                TextButton(
                  onPressed: _loading || _selected.isEmpty ? null : _bulkSync,
                  child: const Text('동기화'),
                ),
                TextButton(
                  onPressed:
                      _loading || _selected.isEmpty ? null : _bulkRedeploy,
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
                '아직 확정된 상품이 없어요. 작업 탭에서 미리보기 → 업로드 실행 후, 우상단 + 버튼으로 기존 쿠팡 상품도 가져올 수 있어요.',
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
              itemCount: _products.length,
              separatorBuilder: (_, __) => const SizedBox(height: 10),
              itemBuilder: (ctx, i) {
                final p = _products[i];
                final id = (p['id'] ?? '').toString();
                final title = (p['confirmedTitle'] ?? '').toString();
                final status = (p['status'] ?? '').toString();
                final img = (p['mainImageUrl'] ?? '').toString();
                final sellerProductId = (p['sellerProductId'] ?? '').toString();
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
                                  color: Theme.of(context).colorScheme.primary,
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
        ],
      ),
    );
  }
}
