import 'package:couplus_mobile/api/api_client.dart';
import 'package:couplus_mobile/screens/recommendation_detail_screen.dart';
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
    });
    try {
      final json = await widget.api.getJson('/api/recommendations', query: {
        'limit': '50',
      });
      final list = (json['items'] as List?) ?? const [];
      setState(() => _items =
          list.map((e) => (e as Map).cast<String, dynamic>()).toList());
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  // Upload is done from the detail preview screen.

  Future<void> _uploadSelected() async {
    final urls = _selected.toList();
    if (urls.isEmpty) return;

    setState(() {
      _loading = true;
      _error = null;
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
            _error = '다중 업로드 시작중… ($started/${urls.length})';
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
    });
    try {
      final json = await widget.api
          .postJson('/api/recommendations/fill', {'targetCount': 20});
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
          final progress =
              (job['result']?['progress'] as Map?)?.cast<String, dynamic>() ??
                  {};

          if (progress.isNotEmpty && mounted) {
            final stage = (progress['stage'] ?? '').toString();
            final candidates = (progress['candidates'] ?? 0).toString();
            final validated = (progress['validated'] ?? 0).toString();
            final kept = (progress['kept'] ?? 0).toString();
            final target = (progress['target'] ?? 0).toString();
            setState(() {
              _error =
                  '진행중: $stage (후보 $candidates / 검증 $validated / 유지 $kept/$target)';
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
              const Spacer(),
              Text(
                '기준: 순마진≥3,000원 / 마진율≥30% (검증 통과만 노출)',
                style: TextStyle(
                  color: Theme.of(context)
                      .colorScheme
                      .onSurface
                      .withValues(alpha: 0.6),
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
                  color: Theme.of(context)
                      .colorScheme
                      .onSurface
                      .withValues(alpha: 0.7),
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
                final qc = (it['qc'] as Map?)?.cast<String, dynamic>() ??
                    const <String, dynamic>{};
                final qcTier = (qc['tier'] ?? '-').toString();
                final detailImageCount =
                    int.tryParse((qc['detailImageCount'] ?? 0).toString()) ?? 0;

                final selected = url.isNotEmpty && _selected.contains(url);

                return AppCard(
                  onTap: url.isEmpty
                      ? null
                      : () {
                          Navigator.of(context).push(
                            MaterialPageRoute(
                              builder: (_) => RecommendationDetailScreen(
                                api: widget.api,
                                sourceUrl: url,
                                title: title,
                                thumbUrl: img,
                                qcTier: qcTier,
                                detailImageCount: detailImageCount,
                              ),
                            ),
                          );
                        },
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Padding(
                        padding: const EdgeInsets.only(top: 4),
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
                                width: 66,
                                height: 66,
                                color: Theme.of(context)
                                    .colorScheme
                                    .surfaceContainerHighest,
                                child: Icon(Icons.image_outlined,
                                    color: Theme.of(context)
                                        .colorScheme
                                        .onSurface
                                        .withValues(alpha: 0.5)),
                              )
                            : Image.network(
                                widget.api.proxyImageUrl(img),
                                width: 66,
                                height: 66,
                                fit: BoxFit.cover,
                                errorBuilder: (_, __, ___) => Container(
                                  width: 66,
                                  height: 66,
                                  color: Theme.of(context)
                                      .colorScheme
                                      .surfaceContainerHighest,
                                  child: Icon(Icons.broken_image,
                                      color: Theme.of(context)
                                          .colorScheme
                                          .onSurface
                                          .withValues(alpha: 0.5)),
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
                              style:
                                  const TextStyle(fontWeight: FontWeight.w900),
                            ),
                            const SizedBox(height: 6),
                            Wrap(
                              spacing: 8,
                              runSpacing: 6,
                              children: [
                                if (keyword.isNotEmpty)
                                  InfoChip(
                                    label: keyword,
                                    color:
                                        Theme.of(context).colorScheme.outline,
                                  ),
                                InfoChip(
                                  label: '권장가 ${(finalPrice as num).round()}',
                                  color: Theme.of(context).colorScheme.primary,
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
                            const SizedBox(height: 8),
                            Row(
                              children: [
                                FilledButton.tonalIcon(
                                  onPressed: (url.isEmpty || _loading)
                                      ? null
                                      : () {
                                          Navigator.of(context).push(
                                            MaterialPageRoute(
                                              builder: (_) =>
                                                  RecommendationDetailScreen(
                                                api: widget.api,
                                                sourceUrl: url,
                                                title: title,
                                                thumbUrl: img,
                                                qcTier: qcTier,
                                                detailImageCount:
                                                    detailImageCount,
                                              ),
                                            ),
                                          );
                                        },
                                  icon: const Icon(Icons.preview_outlined,
                                      size: 18),
                                  label: const Text('미리보기'),
                                ),
                                const SizedBox(width: 8),
                                TextButton.icon(
                                  onPressed: url.isEmpty
                                      ? null
                                      : () async {
                                          final uri = Uri.tryParse(url);
                                          if (uri != null) {
                                            await launchUrl(uri,
                                                mode: LaunchMode
                                                    .externalApplication);
                                          }
                                        },
                                  icon: const Icon(Icons.open_in_new, size: 18),
                                  label: const Text('도매꾹'),
                                ),
                                const SizedBox(width: 4),
                                TextButton.icon(
                                  onPressed: url.isEmpty
                                      ? null
                                      : () {
                                          Clipboard.setData(
                                              ClipboardData(text: url));
                                          ScaffoldMessenger.of(context)
                                              .showSnackBar(
                                            const SnackBar(
                                                content: Text('URL을 복사했어요.')),
                                          );
                                        },
                                  icon: const Icon(Icons.copy, size: 18),
                                  label: const Text('복사'),
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
                                  color: Theme.of(context)
                                      .colorScheme
                                      .onSurface
                                      .withValues(alpha: 0.6),
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
