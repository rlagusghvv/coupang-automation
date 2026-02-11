import 'package:couplus_mobile/api/api_client.dart';
import 'package:couplus_mobile/ui/widgets.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

class RecommendationsScreen extends StatefulWidget {
  const RecommendationsScreen({super.key, required this.api});

  final ApiClient api;

  @override
  State<RecommendationsScreen> createState() => _RecommendationsScreenState();
}

class _RecommendationsScreenState extends State<RecommendationsScreen> {
  bool _loading = false;
  String? _error;
  String? _progress;
  List<Map<String, dynamic>> _items = const [];
  final Set<String> _selected = <String>{};

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
      _progress = null;
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

  Future<void> _uploadNow(String url, {String? titleOverride}) async {
    final u = url.trim();
    if (u.isEmpty) return;

    setState(() {
      _loading = true;
      _error = null;
      _progress = null;
    });

    try {
      final payload = <String, dynamic>{
        'kind': 'upload',
        'url': u,
        'force': '0',
      };
      if (titleOverride != null && titleOverride.trim().isNotEmpty) {
        payload['titleOverride'] = titleOverride.trim();
      }

      final json = await widget.api.postJson('/api/jobs/start', payload);
      final job = (json['job'] as Map?)?.cast<String, dynamic>() ?? {};
      final jobId = (job['id'] ?? '').toString();

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('업로드를 시작했어요. (백그라운드 작업)')),
        );
      }

      if (jobId.isNotEmpty) {
        // Poll job for up to ~10 minutes.
        for (var i = 0; i < 300; i += 1) {
          await Future<void>.delayed(const Duration(seconds: 2));
          final j = await widget.api.getJson('/api/jobs/$jobId');
          final job = (j['job'] as Map?)?.cast<String, dynamic>() ?? {};
          final status = (job['status'] ?? '').toString();
          final progress = (job['result']?['progress'] as Map?)?.cast<String, dynamic>() ?? {};

          if (progress.isNotEmpty && mounted) {
            final stage = (progress['stage'] ?? '').toString();
            setState(() {
              _progress = stage.isEmpty ? null : '업로드 진행중: $stage';
            });
          }

          if (status == 'success') {
            if (mounted) {
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('업로드 완료!')),
              );
            }
            break;
          }
          if (status == 'failed') {
            throw Exception(job['errorMessage'] ?? '업로드 실패');
          }
        }
      }
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<String?> _promptRename({required String initial}) async {
    final c = TextEditingController(text: initial);
    return showDialog<String>(
      context: context,
      builder: (ctx) {
        return AlertDialog(
          title: const Text('상품명 수정'),
          content: TextField(
            controller: c,
            autofocus: true,
            decoration: const InputDecoration(
              hintText: '업로드할 상품명',
            ),
            onSubmitted: (_) => Navigator.of(ctx).pop(c.text),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(null),
              child: const Text('취소'),
            ),
            FilledButton(
              onPressed: () => Navigator.of(ctx).pop(c.text),
              child: const Text('적용'),
            ),
          ],
        );
      },
    );
  }

  Future<void> _uploadSelected() async {
    final urls = _selected.toList();
    if (urls.isEmpty) return;

    setState(() {
      _loading = true;
      _error = null;
      _progress = null;
    });

    try {
      int started = 0;
      for (final u in urls) {
        // Start job (do not block on completion for bulk)
        await widget.api.postJson('/api/jobs/start', {
          'kind': 'upload',
          'url': u,
          'force': '0',
        });
        started += 1;
        if (mounted) {
          setState(() {
            _progress = '다중 업로드 시작중… ($started/${urls.length})';
          });
        }
        await Future<void>.delayed(const Duration(milliseconds: 350));
      }

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('선택한 ${urls.length}개 업로드 작업을 시작했어요.')),
        );
      }

      setState(() {
        _selected.clear();
      });
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
      _progress = null;
    });
    try {
      final json = await widget.api.postJson('/api/recommendations/fill', {
        'targetCount': 60,
        // reset: rebuild list even if already full
        'reset': '1',
      });
      final job = (json['job'] as Map?)?.cast<String, dynamic>() ?? {};
      final jobId = (job['id'] ?? '').toString();

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('추천 생성 시작했어요. 잠시만 기다려주세요…')),
        );
      }

      if (jobId.isNotEmpty) {
        // Poll job for up to ~15 minutes and show progress if available.
        for (var i = 0; i < 450; i += 1) {
          await Future<void>.delayed(const Duration(seconds: 2));
          final j = await widget.api.getJson('/api/jobs/$jobId');
          final job = (j['job'] as Map?)?.cast<String, dynamic>() ?? {};
          final status = (job['status'] ?? '').toString();
          final progress = (job['result']?['progress'] as Map?)?.cast<String, dynamic>() ?? {};

          if (progress.isNotEmpty && mounted) {
            final stage = (progress['stage'] ?? '').toString();
            final candidates = (progress['candidates'] ?? 0).toString();
            final validated = (progress['validated'] ?? 0).toString();
            final kept = (progress['kept'] ?? 0).toString();
            final target = (progress['target'] ?? 0).toString();
            setState(() {
              _progress = '추천 생성중: $stage (후보 $candidates / 검증 $validated / 유지 $kept/$target)';
            });
          }

          if (status == 'success') break;
          if (status == 'failed') {
            throw Exception(job['errorMessage'] ?? '추천 생성 실패');
          }
        }
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
    final selectedCount = _selected.length;

    return AppScaffold(
      title: selectedCount > 0 ? '추천 (선택 $selectedCount)' : '추천',
      onRefresh: _refresh,
      actions: [
        if (selectedCount > 0)
          IconButton(
            onPressed: _loading
                ? null
                : () {
                    setState(() => _selected.clear());
                  },
            icon: const Icon(Icons.clear_all),
            tooltip: '선택 해제',
          ),
        IconButton(
          onPressed: _loading ? null : _runNow,
          icon: const Icon(Icons.auto_awesome),
          tooltip: '추천 채우기',
        ),
        IconButton(
          onPressed: _loading ? null : _refresh,
          icon: const Icon(Icons.refresh),
        ),
      ],
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (_loading) const LinearProgressIndicator(minHeight: 2),
          if (_loading) const SizedBox(height: 12),
          if (selectedCount > 0) ...[
            AppCard(
              child: Row(
                children: [
                  Expanded(child: Text('선택한 $selectedCount개')),
                  FilledButton.tonalIcon(
                    onPressed: _loading ? null : _uploadSelected,
                    icon: const Icon(Icons.cloud_upload_outlined, size: 18),
                    label: const Text('선택 업로드'),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 10),
          ],
          Row(
            children: [
              InfoChip(
                label: _loading ? '불러오는 중…' : '총 ${_items.length}개',
                color: Theme.of(context).colorScheme.primary,
              ),
              const SizedBox(width: 8),
              InfoChip(
                label: '순마진≥3천 · 마진≥30%',
                color: Theme.of(context).colorScheme.outline,
              ),
            ],
          ),
          if (_progress != null) ...[
            const SizedBox(height: 12),
            AppCard(
              child: Row(
                children: [
                  Icon(Icons.hourglass_top,
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: 0.7)),
                  const SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      _progress!,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: Theme.of(context)
                            .colorScheme
                            .onSurface
                            .withValues(alpha: 0.8),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
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

                final selected = url.isNotEmpty && _selected.contains(url);

                Future<void> openExternal() async {
                  final uri = Uri.tryParse(url);
                  if (uri != null) {
                    await launchUrl(uri, mode: LaunchMode.externalApplication);
                  }
                }

                void copyUrl() {
                  Clipboard.setData(ClipboardData(text: url));
                  ScaffoldMessenger.of(context).showSnackBar(
                    const SnackBar(content: Text('URL을 복사했어요.')),
                  );
                }

                Future<void> uploadWithRename() async {
                  final nextTitle = await _promptRename(initial: title);
                  if (nextTitle == null) return;
                  await _uploadNow(url, titleOverride: nextTitle);
                }

                return AppCard(
                  onTap: url.isEmpty
                      ? null
                      : () {
                          setState(() {
                            if (_selected.contains(url)) {
                              _selected.remove(url);
                            } else {
                              _selected.add(url);
                            }
                          });
                        },
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Padding(
                            padding: const EdgeInsets.only(top: 2),
                            child: Checkbox(
                              value: selected,
                              onChanged: url.isEmpty
                                  ? null
                                  : (v) {
                                      setState(() {
                                        if (v == true) {
                                          _selected.add(url);
                                        } else {
                                          _selected.remove(url);
                                        }
                                      });
                                    },
                            ),
                          ),
                          ClipRRect(
                            borderRadius: BorderRadius.circular(10),
                            child: img.isEmpty
                                ? Container(
                                    width: 60,
                                    height: 60,
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
                                    widget.api.proxyImageUrl(img),
                                    width: 60,
                                    height: 60,
                                    fit: BoxFit.cover,
                                    errorBuilder: (_, __, ___) => Container(
                                      width: 60,
                                      height: 60,
                                      color: Theme.of(context)
                                          .colorScheme
                                          .surfaceContainerHighest,
                                      child: Icon(
                                        Icons.broken_image,
                                        color: Theme.of(context)
                                            .colorScheme
                                            .onSurface
                                            .withValues(alpha: 0.5),
                                      ),
                                    ),
                                  ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    Expanded(
                                      child: Text(
                                        title.isEmpty ? '(제목 없음)' : title,
                                        maxLines: 2,
                                        overflow: TextOverflow.ellipsis,
                                        style: const TextStyle(
                                            fontWeight: FontWeight.w900),
                                      ),
                                    ),
                                    PopupMenuButton<String>(
                                      enabled: url.isNotEmpty,
                                      onSelected: (v) async {
                                        if (v == 'upload') {
                                          await uploadWithRename();
                                        } else if (v == 'open') {
                                          await openExternal();
                                        } else if (v == 'copy') {
                                          copyUrl();
                                        }
                                      },
                                      itemBuilder: (ctx) => [
                                        const PopupMenuItem(
                                            value: 'upload', child: Text('업로드')),
                                        const PopupMenuItem(
                                            value: 'open', child: Text('도매꾹 열기')),
                                        const PopupMenuItem(
                                            value: 'copy', child: Text('URL 복사')),
                                      ],
                                    ),
                                  ],
                                ),
                                const SizedBox(height: 8),
                                Wrap(
                                  spacing: 8,
                                  runSpacing: 6,
                                  children: [
                                    if (keyword.isNotEmpty)
                                      InfoChip(
                                        label: '검색어: $keyword',
                                        color: Theme.of(context)
                                            .colorScheme
                                            .outline,
                                      ),
                                    InfoChip(
                                      label:
                                          '권장가 ${(finalPrice as num).round()}',
                                      color:
                                          Theme.of(context).colorScheme.primary,
                                    ),
                                    InfoChip(
                                      label: '순마진 ${(profit as num).round()}',
                                      color: const Color(0xFF2F9E44),
                                    ),
                                    InfoChip(
                                      label:
                                          '마진 ${(((marginRate as num)) * 100).round()}%',
                                      color: const Color(0xFF2F9E44),
                                    ),
                                  ],
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                      if (reason.isNotEmpty) ...[
                        const SizedBox(height: 10),
                        Text(
                          reason,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: TextStyle(
                            color: Theme.of(context)
                                .colorScheme
                                .onSurface
                                .withValues(alpha: 0.6),
                            fontSize: 12,
                          ),
                        ),
                      ],
                      const SizedBox(height: 10),
                      Row(
                        children: [
                          Expanded(
                            child: FilledButton.tonalIcon(
                              onPressed: (url.isEmpty || _loading)
                                  ? null
                                  : () async => uploadWithRename(),
                              icon: const Icon(Icons.cloud_upload_outlined,
                                  size: 18),
                              label: const Text('업로드'),
                            ),
                          ),
                          const SizedBox(width: 8),
                          IconButton(
                            tooltip: '도매꾹 열기',
                            onPressed:
                                (url.isEmpty) ? null : () async => openExternal(),
                            icon: const Icon(Icons.open_in_new),
                          ),
                          IconButton(
                            tooltip: 'URL 복사',
                            onPressed: (url.isEmpty) ? null : copyUrl,
                            icon: const Icon(Icons.copy),
                          ),
                        ],
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
