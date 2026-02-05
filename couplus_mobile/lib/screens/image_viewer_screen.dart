import 'package:flutter/material.dart';

class ImageViewerScreen extends StatefulWidget {
  const ImageViewerScreen({
    super.key,
    required this.images,
    this.initialIndex = 0,
    this.title,
  });

  final List<String> images;
  final int initialIndex;
  final String? title;

  @override
  State<ImageViewerScreen> createState() => _ImageViewerScreenState();
}

class _ImageViewerScreenState extends State<ImageViewerScreen> {
  late final PageController _controller;
  late int _index;

  @override
  void initState() {
    super.initState();
    _index = widget.initialIndex
        .clamp(0, (widget.images.length - 1).clamp(0, 1 << 30));
    _controller = PageController(initialPage: _index);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final images = widget.images;

    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: Text(widget.title ?? '${_index + 1} / ${images.length}'),
      ),
      body: PageView.builder(
        controller: _controller,
        itemCount: images.length,
        onPageChanged: (i) => setState(() => _index = i),
        itemBuilder: (_, i) {
          final src = images[i];
          return InteractiveViewer(
            minScale: 1,
            maxScale: 4,
            child: Center(
              child: Image.network(
                src,
                fit: BoxFit.contain,
                loadingBuilder: (ctx, child, prog) {
                  if (prog == null) return child;
                  return const CircularProgressIndicator();
                },
                errorBuilder: (_, __, ___) => Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const Icon(Icons.broken_image,
                          color: Colors.white70, size: 48),
                      const SizedBox(height: 10),
                      const Text(
                        '이미지를 불러오지 못했어요.',
                        style: TextStyle(color: Colors.white70),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        src,
                        style: const TextStyle(
                            color: Colors.white38, fontSize: 12),
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        textAlign: TextAlign.center,
                      ),
                    ],
                  ),
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}
