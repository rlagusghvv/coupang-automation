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
  String? _lastRunSummary;
  List<Map<String, dynamic>> _items = const [];
  List<Map<String, dynamic>> _savedItems = const [];
  final Set<String> _savedUrls = <String>{};
  bool _showSavedOnly = false;
  final Set<String> _selected = <String>{};

  List<Map<String, dynamic>> get _visibleItems =>
      _showSavedOnly ? _savedItems : _items;

  String _nowLabel() {
    final n = DateTime.now();
    final hh = n.hour.toString().padLeft(2, '0');
    final mm = n.minute.toString().padLeft(2, '0');
    final ss = n.second.toString().padLeft(2, '0');
    return '$hh:$mm:$ss';
  }

  String _diagnosticsHint(Map<String, dynamic> diagnostics) {
    final hint = (diagnostics['hint'] ?? '').toString().trim();
    if (hint.isNotEmpty) return hint;

    final keywordDiagnostics = (diagnostics['keywordDiagnostics'] as List?) ?? const [];
    for (final raw in keywordDiagnostics) {
      if (raw is! Map) continue;
      final errors = (raw['errors'] as List?) ?? const [];
      for (final e in errors) {
        final text = e.toString().trim();
        if (text.isNotEmpty) return '후보 수집 오류: $text';
      }
    }

    final collected =
        int.tryParse((diagnostics['collectedCandidates'] ?? 0).toString()) ?? 0;
    if (collected == 0) {
      return '후보가 0개입니다. 키워드/네트워크 상태를 확인해 주세요.';
    }
    return '';
  }

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
      final recoJson = await widget.api.getJson('/api/recommendations', query: {
        'limit': '50',
      });
      final savedJson =
          await widget.api.getJson('/api/recommendations/saved', query: {
        'limit': '200',
      });
      final reco = (recoJson['items'] as List?) ?? const [];
      final saved = (savedJson['items'] as List?) ?? const [];
      setState(() {
        _items = reco.map((e) => (e as Map).cast<String, dynamic>()).toList();
        _savedItems =
            saved.map((e) => (e as Map).cast<String, dynamic>()).toList();
        _savedUrls
          ..clear()
          ..addAll(_savedItems
              .map((e) => (e['sourceUrl'] ?? '').toString().trim())
              .where((u) => u.isNotEmpty));
      });
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _reloadListQuietly() async {
    try {
      final recoJson = await widget.api.getJson('/api/recommendations', query: {
        'limit': '50',
      });
      final savedJson =
          await widget.api.getJson('/api/recommendations/saved', query: {
        'limit': '200',
      });
      final reco = (recoJson['items'] as List?) ?? const [];
      final saved = (savedJson['items'] as List?) ?? const [];
      if (!mounted) return;
      setState(() {
        _items = reco.map((e) => (e as Map).cast<String, dynamic>()).toList();
        _savedItems =
            saved.map((e) => (e as Map).cast<String, dynamic>()).toList();
        _savedUrls
          ..clear()
          ..addAll(_savedItems
              .map((e) => (e['sourceUrl'] ?? '').toString().trim())
              .where((u) => u.isNotEmpty));
      });
    } catch (_) {
      // best-effort sync only
    }
  }

  Future<void> _toggleSave(Map<String, dynamic> item) async {
    final url = (item['sourceUrl'] ?? '').toString().trim();
    if (url.isEmpty) return;
    final wasSaved = _savedUrls.contains(url);
    setState(() {
      if (wasSaved) {
        _savedUrls.remove(url);
      } else {
        _savedUrls.add(url);
      }
    });
    try {
      if (wasSaved) {
        await widget.api.deleteJson(
          '/api/recommendations/saved?sourceUrl=${Uri.encodeComponent(url)}',
        );
      } else {
        await widget.api.postJson('/api/recommendations/saved', {'item': item});
      }
      await _reloadListQuietly();
    } catch (e) {
      // rollback optimistic state
      setState(() {
        if (wasSaved) {
          _savedUrls.add(url);
        } else {
          _savedUrls.remove(url);
        }
      });
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('저장 처리 실패: $e')),
        );
      }
    }
  }

  Future<Map<String, dynamic>?> _editBulkTitleOverrides(
    List<Map<String, dynamic>> targets,
  ) async {
    final controllers = <String, TextEditingController>{};
    for (final item in targets) {
      final url = (item['sourceUrl'] ?? '').toString().trim();
      if (url.isEmpty || controllers.containsKey(url)) continue;
      controllers[url] = TextEditingController(
        text: (item['title'] ?? '').toString(),
      );
    }
    if (controllers.isEmpty) return {};

    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) {
        return AlertDialog(
          title: const Text('다중 업로드 상품명 수정'),
          content: SizedBox(
            width: 640,
            child: ListView(
              shrinkWrap: true,
              children: targets.map((item) {
                final url = (item['sourceUrl'] ?? '').toString().trim();
                final c = controllers[url];
                if (c == null) return const SizedBox.shrink();
                return Padding(
                  padding: const EdgeInsets.only(bottom: 10),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        (item['title'] ?? '(제목 없음)').toString(),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 12),
                      ),
                      const SizedBox(height: 4),
                      TextField(
                        controller: c,
                        decoration: const InputDecoration(
                          labelText: '업로드 상품명',
                          isDense: true,
                        ),
                      ),
                    ],
                  ),
                );
              }).toList(),
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.of(ctx).pop(false),
              child: const Text('취소'),
            ),
            FilledButton(
              onPressed: () => Navigator.of(ctx).pop(true),
              child: const Text('업로드'),
            ),
          ],
        );
      },
    );

    final overrides = <String, dynamic>{};
    if (ok == true) {
      for (final entry in controllers.entries) {
        final nextTitle = entry.value.text.trim();
        if (nextTitle.isEmpty) continue;
        overrides[entry.key] = {
          'titleOverride': nextTitle,
        };
      }
    }

    for (final c in controllers.values) {
      c.dispose();
    }
    if (ok != true) return null;
    return overrides;
  }

  Future<void> _runNow() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final json = await widget.api.postJson('/api/recommendations/fill', {
        'targetCount': 6,
      });
      final list = (json['items'] as List?) ?? const [];
      final fill = (json['fill'] as Map?)?.cast<String, dynamic>() ??
          const <String, dynamic>{};
      final removed =
          int.tryParse((fill['removedCount'] ?? 0).toString()) ?? 0;
      final count =
          int.tryParse((fill['count'] ?? list.length).toString()) ??
              list.length;
      final cooldown =
          int.tryParse((fill['cooldownDays'] ?? 7).toString()) ?? 7;
      final diagnostics =
          (fill['diagnostics'] as Map?)?.cast<String, dynamic>() ??
              const <String, dynamic>{};
      final hint = _diagnosticsHint(diagnostics);

      setState(() {
        _items = list.map((e) => (e as Map).cast<String, dynamic>()).toList();
        _selected.clear();
        _showSavedOnly = false;
        _lastRunSummary =
            '마지막 채우기 ${_nowLabel()} · $count개 생성(이전 $removed개 교체)';
      });

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              count > 0
                  ? '추천 채우기 완료: 기존 $removed개 교체, 새 $count개 (재노출 제외 $cooldown일)'
                  : '추천 채우기 완료: 새 0개 (재노출 제외 $cooldown일)${hint.isNotEmpty ? " - $hint" : ""}',
            ),
          ),
        );
      }
    } catch (e) {
      setState(() => _error = e.toString());
      await _reloadListQuietly();
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  // Upload is done from the detail preview screen.

  Future<void> _uploadSelected() async {
    final urls = _selected.toList();
    if (urls.isEmpty) return;
    final byUrl = <String, Map<String, dynamic>>{};
    for (final it in [..._items, ..._savedItems]) {
      final u = (it['sourceUrl'] ?? '').toString().trim();
      if (u.isEmpty) continue;
      byUrl[u] = it;
    }
    final targets =
        urls.map((u) => byUrl[u]).whereType<Map<String, dynamic>>().toList();
    final overrides = await _editBulkTitleOverrides(targets);
    if (overrides == null) return;

    setState(() {
      _loading = true;
      _error = null;
    });

    try {
      final json = await widget.api.postJson('/api/upload/bulk', {
        'urls': urls,
        'force': '0',
        if (overrides.isNotEmpty) 'overridesByUrl': overrides,
      });

      final summary =
          (json['summary'] as Map?)?.cast<String, dynamic>() ?? const {};
      final items = (json['items'] as List?) ?? const [];

      int asInt(dynamic v) {
        return int.tryParse((v ?? 0).toString()) ?? 0;
      }

      final uploaded = asInt(summary['uploaded']);
      final skipped = asInt(summary['skipped']);
      final failed = asInt(summary['failed']);

      final reasonCounts = <String, int>{};
      for (final raw in items) {
        final row = (raw as Map).cast<String, dynamic>();
        if (row['skipped'] == true || row['ok'] == false) {
          final reason = (row['skipReason'] ?? row['error'] ?? 'unknown')
              .toString()
              .trim();
          if (reason.isEmpty) continue;
          reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
        }
      }

      final reasonPreview = reasonCounts.entries.toList()
        ..sort((a, b) => b.value.compareTo(a.value));
      final reasonText = reasonPreview
          .take(3)
          .map((entry) => '${entry.key} ${entry.value}건')
          .join(', ');

      setState(() {
        _selected.clear();
        _error = failed > 0 || skipped > 0
            ? '다중 업로드 완료: 성공 $uploaded / 스킵 $skipped / 실패 $failed'
                '${reasonText.isNotEmpty ? ' ($reasonText)' : ''}'
            : null;
      });

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('다중 업로드 완료: 성공 $uploaded / 스킵 $skipped / 실패 $failed'),
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

  @override
  Widget build(BuildContext context) {
    final selectedCount = _selected.length;
    final visibleItems = _visibleItems;

    return AppScaffold(
      title: selectedCount > 0 ? '추천 (선택 $selectedCount)' : '추천',
      onRefresh: _runNow,
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
          icon: const Icon(Icons.autorenew),
          tooltip: '채우기(기존 목록 교체)',
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
                label: _loading
                    ? '불러오는 중…'
                    : (_showSavedOnly ? '저장함 ${_savedItems.length}개' : '추천 ${_items.length}개'),
                color: Theme.of(context).colorScheme.primary,
              ),
              const SizedBox(width: 8),
              FilterChip(
                label: Text('저장함 ${_savedItems.length}'),
                selected: _showSavedOnly,
                onSelected: _loading
                    ? null
                    : (v) {
                        setState(() {
                          _showSavedOnly = v;
                          _selected.clear();
                        });
                      },
              ),
              const Spacer(),
              Text(
                _showSavedOnly
                    ? '저장한 후보만 표시 중'
                    : '채우기 시 기존 추천 목록은 교체됩니다',
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
          if ((_lastRunSummary ?? '').isNotEmpty) ...[
            const SizedBox(height: 8),
            Text(
              _lastRunSummary ?? '',
              style: TextStyle(
                color: Theme.of(context)
                    .colorScheme
                    .onSurface
                    .withValues(alpha: 0.65),
                fontSize: 12,
              ),
            ),
          ],
          if (_error != null) ...[
            const SizedBox(height: 12),
            ErrorBanner(message: _error!, onRetry: _runNow),
          ],
          const SizedBox(height: 12),
          if (visibleItems.isEmpty && !_loading)
            AppCard(
              child: Text(
                _showSavedOnly
                    ? '저장한 후보가 아직 없어요. 추천 카드에서 북마크 버튼으로 저장할 수 있어요.'
                    : '아직 추천이 없어요. 우측 상단 새로고침 버튼으로 채우기(기존 목록 교체)를 실행하세요.',
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
              itemCount: visibleItems.length,
              separatorBuilder: (_, __) => const SizedBox(height: 10),
              itemBuilder: (ctx, i) {
                final it = visibleItems[i];
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
                final saved = url.isNotEmpty && _savedUrls.contains(url);

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
                                IconButton(
                                  onPressed: (url.isEmpty || _loading)
                                      ? null
                                      : () => _toggleSave(it),
                                  tooltip: saved ? '저장 해제' : '저장',
                                  icon: Icon(
                                    saved
                                        ? Icons.bookmark
                                        : Icons.bookmark_border,
                                    color: saved
                                        ? Theme.of(context).colorScheme.primary
                                        : null,
                                  ),
                                ),
                                const SizedBox(width: 4),
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
