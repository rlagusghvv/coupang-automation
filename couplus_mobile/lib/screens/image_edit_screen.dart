import 'package:flutter/material.dart';
import 'package:couplus_mobile/screens/image_viewer_screen.dart';

class ImageEditScreen extends StatefulWidget {
  const ImageEditScreen({
    super.key,
    required this.initial,
    required this.all,
    this.title = '이미지 편집',
  });

  final List<String> initial;
  final List<String> all;
  final String title;

  @override
  State<ImageEditScreen> createState() => _ImageEditScreenState();
}

class _ImageEditScreenState extends State<ImageEditScreen> {
  late List<String> _list;

  @override
  void initState() {
    super.initState();
    final uniq = <String>[];
    for (final s in widget.initial) {
      final t = s.trim();
      if (t.isEmpty) continue;
      if (uniq.contains(t)) continue;
      uniq.add(t);
    }
    _list = uniq;
  }

  void _removeAt(int i) {
    setState(() => _list.removeAt(i));
  }

  Future<void> _addFromAll() async {
    final available = widget.all
        .map((e) => e.trim())
        .where((e) => e.isNotEmpty)
        .where((e) => !_list.contains(e))
        .toList();

    if (available.isEmpty) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('추가할 이미지가 없어요.')),
      );
      return;
    }

    final picked = await showModalBottomSheet<String>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (ctx) {
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text('이미지 추가',
                    style: TextStyle(fontSize: 16, fontWeight: FontWeight.w900)),
                const SizedBox(height: 10),
                SizedBox(
                  height: MediaQuery.of(ctx).size.height * 0.6,
                  child: ListView.separated(
                    itemCount: available.length,
                    separatorBuilder: (_, __) => const Divider(height: 1),
                    itemBuilder: (_, i) {
                      final src = available[i];
                      return ListTile(
                        leading: ClipRRect(
                          borderRadius: BorderRadius.circular(8),
                          child: SizedBox(
                            width: 54,
                            height: 54,
                            child: Image.network(
                              src,
                              fit: BoxFit.cover,
                              errorBuilder: (_, __, ___) => Container(
                                color: Theme.of(ctx)
                                    .colorScheme
                                    .surfaceContainerHighest,
                                child: Icon(Icons.broken_image,
                                    color: Theme.of(ctx)
                                        .colorScheme
                                        .onSurface
                                        .withValues(alpha: 0.5)),
                              ),
                            ),
                          ),
                        ),
                        title: Text(
                          src,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                        onTap: () => Navigator.of(ctx).pop(src),
                      );
                    },
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );

    if (picked == null || picked.trim().isEmpty) return;
    setState(() => _list.add(picked.trim()));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.title),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(_list),
            child: const Text('완료'),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: _addFromAll,
        label: const Text('추가'),
        icon: const Icon(Icons.add),
      ),
      body: _list.isEmpty
          ? const Center(child: Text('이미지가 없어요.'))
          : ReorderableListView.builder(
              padding: const EdgeInsets.only(bottom: 90),
              itemCount: _list.length,
              onReorder: (oldIndex, newIndex) {
                setState(() {
                  if (newIndex > oldIndex) newIndex -= 1;
                  final item = _list.removeAt(oldIndex);
                  _list.insert(newIndex, item);
                });
              },
              itemBuilder: (ctx, i) {
                final src = _list[i];
                return Dismissible(
                  key: ValueKey(src),
                  direction: DismissDirection.endToStart,
                  background: Container(
                    color: Colors.red,
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    alignment: Alignment.centerRight,
                    child: const Icon(Icons.delete, color: Colors.white),
                  ),
                  confirmDismiss: (_) async {
                    return await showDialog<bool>(
                          context: context,
                          builder: (_) => AlertDialog(
                            title: const Text('이미지 삭제'),
                            content: const Text('이 이미지를 업로드에서 제외할까요?'),
                            actions: [
                              TextButton(
                                  onPressed: () => Navigator.of(context).pop(false),
                                  child: const Text('취소')),
                              TextButton(
                                  onPressed: () => Navigator.of(context).pop(true),
                                  child: const Text('삭제')),
                            ],
                          ),
                        ) ??
                        false;
                  },
                  onDismissed: (_) => _removeAt(i),
                  child: ListTile(
                    key: ValueKey('tile-$src'),
                    leading: GestureDetector(
                      onTap: () {
                        Navigator.of(context).push(
                          MaterialPageRoute(
                            builder: (_) => ImageViewerScreen(
                              images: _list,
                              initialIndex: i,
                              title: '이미지 크게 보기',
                            ),
                          ),
                        );
                      },
                      child: ClipRRect(
                        borderRadius: BorderRadius.circular(10),
                        child: SizedBox(
                          width: 62,
                          height: 62,
                          child: Image.network(
                            src,
                            fit: BoxFit.cover,
                            errorBuilder: (_, __, ___) => Container(
                              color: Theme.of(ctx)
                                  .colorScheme
                                  .surfaceContainerHighest,
                              child: Icon(Icons.broken_image,
                                  color: Theme.of(ctx)
                                      .colorScheme
                                      .onSurface
                                      .withValues(alpha: 0.5)),
                            ),
                          ),
                        ),
                      ),
                    ),
                    title: Text(
                      src,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    subtitle: Text('${i + 1} / ${_list.length}'),
                    trailing: const Icon(Icons.drag_handle),
                  ),
                );
              },
            ),
    );
  }
}
