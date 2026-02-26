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
  String? _lastUploadSummary;
  DateTime? _lastUploadAt;
  List<Map<String, dynamic>> _lastUploadRows = const [];
  String? _activeFillJobId;
  Map<String, dynamic>? _fillProgress;
  DateTime? _fillStartedAt;
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

    final keywordDiagnostics =
        (diagnostics['keywordDiagnostics'] as List?) ?? const [];
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

  String _fillProgressMessage(Map<String, dynamic> progress) {
    final stage = (progress['stage'] ?? '').toString();
    switch (stage) {
      case 'start':
      case 'queued':
        final target =
            int.tryParse((progress['targetCount'] ?? 0).toString()) ?? 0;
        return target > 0 ? '작업 대기열 등록 완료 (목표 $target개)' : '작업 대기열 등록 완료';
      case 'refresh_start':
        final removed =
            int.tryParse((progress['removed'] ?? 0).toString()) ?? 0;
        final excluded =
            int.tryParse((progress['excluded'] ?? 0).toString()) ?? 0;
        return '기존 추천 $removed개 정리 완료 · 재노출 제외 후보 $excluded개';
      case 'collect':
        final keyword = (progress['keyword'] ?? '').toString();
        final candidates =
            int.tryParse((progress['candidates'] ?? 0).toString()) ?? 0;
        return keyword.isNotEmpty
            ? '후보 수집 중: $keyword ($candidates개)'
            : '후보 수집 중: $candidates개';
      case 'validate':
        final validated =
            int.tryParse((progress['validated'] ?? 0).toString()) ?? 0;
        final kept = int.tryParse((progress['kept'] ?? 0).toString()) ?? 0;
        final target = int.tryParse((progress['target'] ?? 0).toString()) ?? 0;
        final qcRejected =
            int.tryParse((progress['qcRejected'] ?? 0).toString()) ?? 0;
        return qcRejected > 0
            ? '품질 검증 중: 검증 $validated건 · 통과 $kept/$target · 탈락 $qcRejected건'
            : '품질 검증 중: 검증 $validated건 · 통과 $kept/$target';
      case 'rate_limited':
        return '도매꾹 요청 제한 감지(429) - 잠시 후 자동 재시도 권장';
      case 'done_empty':
        final hint = (progress['hint'] ?? '').toString().trim();
        final validated =
            int.tryParse((progress['validated'] ?? 0).toString()) ?? 0;
        final qcRejected =
            int.tryParse((progress['qcRejected'] ?? 0).toString()) ?? 0;
        final scoredCandidates =
            int.tryParse((progress['scoredCandidates'] ?? 0).toString()) ?? 0;
        if (hint.isNotEmpty) return '완료(0개): $hint';
        if (validated > 0 || qcRejected > 0) {
          return '완료(0개): 검증 $validated건 · QC 탈락 $qcRejected건';
        }
        if (scoredCandidates == 0) {
          return '완료(0개): 점수 조건 통과 후보가 없습니다';
        }
        return '완료(0개): 조건 통과 항목 없음';
      case 'done':
        final count = int.tryParse((progress['count'] ?? 0).toString()) ?? 0;
        final removed =
            int.tryParse((progress['removedCount'] ?? 0).toString()) ?? 0;
        if (count <= 0) {
          final hint = (progress['hint'] ?? '').toString().trim();
          return hint.isNotEmpty ? '완료(0개): $hint' : '완료(0개): 조건 통과 항목 없음';
        }
        return '완료: 기존 $removed개 교체, 새 $count개';
      default:
        return '추천 채우기 진행 중...';
    }
  }

  double? _fillProgressRatio(Map<String, dynamic> progress) {
    final stage = (progress['stage'] ?? '').toString();
    if (stage != 'validate') return null;
    final kept = int.tryParse((progress['kept'] ?? 0).toString()) ?? 0;
    final target = int.tryParse((progress['target'] ?? 0).toString()) ?? 0;
    if (target <= 0) return null;
    final ratio = kept / target;
    if (ratio <= 0) return 0;
    if (ratio >= 1) return 1;
    return ratio;
  }

  String _fillElapsedLabel() {
    final started = _fillStartedAt;
    if (started == null) return '';
    final sec = DateTime.now().difference(started).inSeconds;
    if (sec <= 0) return '';
    return '${sec}s';
  }

  String _uploadAtLabel() {
    final at = _lastUploadAt;
    if (at == null) return '';
    final hh = at.hour.toString().padLeft(2, '0');
    final mm = at.minute.toString().padLeft(2, '0');
    final ss = at.second.toString().padLeft(2, '0');
    return '$hh:$mm:$ss';
  }

  String _comma(int n) {
    final text = n.toString();
    return text.replaceAllMapped(
      RegExp(r'\B(?=(\d{3})+(?!\d))'),
      (_) => ',',
    );
  }

  String _won(dynamic value) {
    final n = num.tryParse((value ?? '').toString());
    if (n == null) return '-';
    return '${_comma(n.round())}원';
  }

  String _humanizeSkipReason(String raw) {
    final key = raw.trim();
    switch (key) {
      case 'qc_gate_failed':
        return 'QC 기준 미달';
      case 'duplicate_url':
        return '중복 URL';
      case 'duplicate_title':
        return '중복 제목';
      case 'duplicate_fingerprint':
        return '중복 이미지';
      case 'preview_failed':
        return '미리보기 실패';
      case 'no_images':
        return '이미지 없음';
      default:
        return key.isEmpty ? '-' : key;
    }
  }

  List<String> _previewImagesOf(Map<String, dynamic> item, {int max = 6}) {
    final raw = (item['previewImages'] as List?) ?? const [];
    final images =
        raw.map((e) => e.toString().trim()).where((s) => s.isNotEmpty).toList();
    if (max <= 0) return images;
    return images.take(max).toList();
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

  Future<void> _applyFillResponse(Map<String, dynamic> json) async {
    final list = (json['items'] as List?) ?? const [];
    final fill = (json['fill'] as Map?)?.cast<String, dynamic>() ??
        const <String, dynamic>{};
    final removed = int.tryParse((fill['removedCount'] ?? 0).toString()) ?? 0;
    final count =
        int.tryParse((fill['count'] ?? list.length).toString()) ?? list.length;
    final cooldown = int.tryParse((fill['cooldownDays'] ?? 7).toString()) ?? 7;
    final diagnostics =
        (fill['diagnostics'] as Map?)?.cast<String, dynamic>() ??
            const <String, dynamic>{};
    final hint = _diagnosticsHint(diagnostics);

    setState(() {
      _items = list.map((e) => (e as Map).cast<String, dynamic>()).toList();
      _selected.clear();
      _showSavedOnly = false;
      _lastRunSummary = count > 0
          ? '마지막 채우기 ${_nowLabel()} · $count개 생성(이전 $removed개 교체)'
          : '마지막 채우기 ${_nowLabel()} · 결과 0개${hint.isNotEmpty ? " ($hint)" : ""}';
      _fillProgress = {
        'stage': count > 0 ? 'done' : 'done_empty',
        'count': count,
        'removedCount': removed,
        'hint': hint,
        'validated': diagnostics['validated'] ?? 0,
        'qcRejected': diagnostics['qcRejected'] ?? 0,
        'scoredCandidates': diagnostics['scoredCandidates'] ?? 0,
      };
      _activeFillJobId = null;
    });

    if (!mounted) return;
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

  Future<Map<String, dynamic>?> _pollFillJob(String jobId) async {
    for (var i = 0; i < 180; i += 1) {
      await Future<void>.delayed(const Duration(seconds: 1));
      final j = await widget.api.getJson('/api/jobs/$jobId');
      final job = (j['job'] as Map?)?.cast<String, dynamic>() ?? const {};
      final progress = (job['progress'] as Map?)?.cast<String, dynamic>() ??
          const <String, dynamic>{};
      if (mounted) {
        setState(() {
          _fillProgress = progress;
        });
      }
      final status = (job['status'] ?? '').toString().toLowerCase();
      if (status == 'success' || status == 'done') {
        final result = (job['result'] as Map?)?.cast<String, dynamic>() ?? {};
        if (result.isNotEmpty) return result;
        final fill = (job['fill'] as Map?)?.cast<String, dynamic>() ?? {};
        final items = (job['items'] as List?) ?? const [];
        return {
          'fill': fill,
          'items': items,
        };
      }
      if (status == 'failed') {
        final message = (job['errorMessage'] ?? job['error'] ?? '추천 채우기 실패')
            .toString()
            .trim();
        throw Exception(message.isEmpty ? '추천 채우기 실패' : message);
      }
    }
    return null;
  }

  Future<void> _runNow() async {
    setState(() {
      _loading = true;
      _error = null;
      _fillStartedAt = DateTime.now();
      _fillProgress = const {'stage': 'queued'};
    });
    try {
      Map<String, dynamic>? startJson;
      try {
        startJson =
            await widget.api.postJson('/api/recommendations/fill/start', {
          'targetCount': 6,
        });
      } on ApiException catch (e) {
        if (e.statusCode != 404) rethrow;
      }

      final job = (startJson?['job'] as Map?)?.cast<String, dynamic>() ?? {};
      final jobId = (job['id'] ?? '').toString().trim();
      if (jobId.isNotEmpty) {
        setState(() {
          _activeFillJobId = jobId;
          _fillProgress = (job['progress'] as Map?)?.cast<String, dynamic>() ??
              const {'stage': 'queued'};
        });
        final result = await _pollFillJob(jobId);
        if (result == null) {
          throw Exception('추천 채우기 진행시간이 길어져 타임아웃되었습니다. 다시 시도해 주세요.');
        }
        await _applyFillResponse(result);
      } else {
        // Fallback for older server runtimes without async fill job endpoint.
        final json = await widget.api.postJson('/api/recommendations/fill', {
          'targetCount': 6,
        });
        await _applyFillResponse(json);
      }
    } catch (e) {
      setState(() {
        _error = e.toString();
        _activeFillJobId = null;
      });
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
      final successIds = <String>{};

      final reasonCounts = <String, int>{};
      for (final raw in items) {
        final row = (raw as Map).cast<String, dynamic>();
        final sellerProductId =
            (row['sellerProductId'] ?? '').toString().trim();
        if (sellerProductId.isNotEmpty) {
          successIds.add(sellerProductId);
        }
        if (row['skipped'] == true || row['ok'] == false) {
          final reasonRaw = (row['skipReason'] ?? row['error'] ?? 'unknown')
              .toString()
              .trim();
          final reason = _humanizeSkipReason(reasonRaw);
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
        _lastUploadAt = DateTime.now();
        _lastUploadSummary =
            '다중 업로드 완료: 성공 $uploaded / 스킵 $skipped / 실패 $failed'
            '${successIds.isNotEmpty ? ' / 등록ID ${successIds.length}건' : ''}'
            '${reasonText.isNotEmpty ? ' ($reasonText)' : ''}';
        _lastUploadRows = items
            .map((raw) => (raw as Map).cast<String, dynamic>())
            .take(12)
            .toList();
        _error = null;
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
    final fillStage = (_fillProgress?['stage'] ?? '').toString();
    final fillCount =
        int.tryParse((_fillProgress?['count'] ?? 0).toString()) ?? 0;
    final fillDone = fillStage == 'done' || fillStage == 'done_empty';
    final fillEmptyDone =
        fillStage == 'done_empty' || (fillStage == 'done' && fillCount <= 0);
    final fillRunning =
        _loading || ((_activeFillJobId ?? '').isNotEmpty && !fillDone);

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
          if (_fillProgress != null) ...[
            AppCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Icon(
                        fillRunning
                            ? Icons.sync
                            : (fillEmptyDone
                                ? Icons.warning_amber_rounded
                                : Icons.task_alt),
                        size: 18,
                        color: fillEmptyDone
                            ? Theme.of(context).colorScheme.error
                            : Theme.of(context).colorScheme.primary,
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          fillRunning
                              ? '추천 채우기 진행 중'
                              : (fillEmptyDone ? '추천 채우기 결과 없음' : '추천 채우기 상태'),
                          style: const TextStyle(fontWeight: FontWeight.w800),
                        ),
                      ),
                      if ((_activeFillJobId ?? '').isNotEmpty)
                        Text(
                          '#${_activeFillJobId!.length > 8 ? _activeFillJobId!.substring(0, 8) : _activeFillJobId!}',
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
                  const SizedBox(height: 8),
                  Text(
                    _fillProgressMessage(_fillProgress!),
                    style: TextStyle(
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: 0.85),
                    ),
                  ),
                  if (_fillElapsedLabel().isNotEmpty) ...[
                    const SizedBox(height: 4),
                    Text(
                      '경과 시간: ${_fillElapsedLabel()}',
                      style: TextStyle(
                        fontSize: 12,
                        color: Theme.of(context)
                            .colorScheme
                            .onSurface
                            .withValues(alpha: 0.6),
                      ),
                    ),
                  ],
                  if (_fillProgressRatio(_fillProgress!) != null) ...[
                    const SizedBox(height: 10),
                    LinearProgressIndicator(
                        value: _fillProgressRatio(_fillProgress!)),
                  ],
                ],
              ),
            ),
            const SizedBox(height: 10),
          ],
          if ((_lastUploadSummary ?? '').isNotEmpty) ...[
            AppCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Icon(
                        Icons.cloud_done_outlined,
                        size: 18,
                        color: Theme.of(context).colorScheme.primary,
                      ),
                      const SizedBox(width: 8),
                      const Expanded(
                        child: Text(
                          '마지막 업로드 결과',
                          style: TextStyle(fontWeight: FontWeight.w800),
                        ),
                      ),
                      if (_uploadAtLabel().isNotEmpty)
                        Text(
                          _uploadAtLabel(),
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
                  const SizedBox(height: 8),
                  Text(
                    _lastUploadSummary ?? '',
                    style: TextStyle(
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: 0.85),
                    ),
                  ),
                  if (_lastUploadRows.isNotEmpty) ...[
                    const SizedBox(height: 10),
                    Column(
                      children: _lastUploadRows.map((row) {
                        final ok = row['ok'] == true;
                        final skipped = row['skipped'] == true;
                        final url = (row['url'] ?? '').toString().trim();
                        final sellerProductId =
                            (row['sellerProductId'] ?? '').toString().trim();
                        final productId =
                            (row['productId'] ?? '').toString().trim();
                        final statusName =
                            (row['statusName'] ?? '').toString().trim();
                        final productUrl =
                            (row['productUrl'] ?? '').toString().trim();
                        final reasonRaw =
                            (row['skipReason'] ?? row['error'] ?? '')
                                .toString()
                                .trim();
                        final reason = _humanizeSkipReason(reasonRaw);
                        final statusText =
                            ok && !skipped ? '성공' : (skipped ? '스킵' : '실패');
                        final statusColor = ok && !skipped
                            ? const Color(0xFF2F9E44)
                            : (skipped
                                ? Theme.of(context).colorScheme.tertiary
                                : Theme.of(context).colorScheme.error);
                        return Padding(
                          padding: const EdgeInsets.only(bottom: 6),
                          child: Row(
                            children: [
                              Icon(
                                ok && !skipped
                                    ? Icons.check_circle_outline
                                    : (skipped
                                        ? Icons.remove_circle_outline
                                        : Icons.error_outline),
                                size: 16,
                                color: statusColor,
                              ),
                              const SizedBox(width: 6),
                              Text(
                                statusText,
                                style: TextStyle(
                                  fontSize: 12,
                                  fontWeight: FontWeight.w700,
                                  color: statusColor,
                                ),
                              ),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Text(
                                  (sellerProductId.isNotEmpty ||
                                          productId.isNotEmpty)
                                      ? 'SPID ${sellerProductId.isEmpty ? '-' : sellerProductId}'
                                          '${productId.isNotEmpty ? ' / PID $productId' : ''}'
                                          '${statusName.isNotEmpty ? ' / $statusName' : ''}'
                                      : (reason.isNotEmpty
                                          ? reason
                                          : (url.isNotEmpty ? url : '-')),
                                  maxLines: 1,
                                  overflow: TextOverflow.ellipsis,
                                  style: TextStyle(
                                    fontSize: 12,
                                    color: Theme.of(context)
                                        .colorScheme
                                        .onSurface
                                        .withValues(alpha: 0.75),
                                  ),
                                ),
                              ),
                              if (productUrl.isNotEmpty) ...[
                                const SizedBox(width: 4),
                                IconButton(
                                  tooltip: '쿠팡 상품 열기',
                                  icon: const Icon(Icons.open_in_new, size: 18),
                                  onPressed: () async {
                                    final uri = Uri.tryParse(productUrl);
                                    if (uri != null) {
                                      await launchUrl(
                                        uri,
                                        mode: LaunchMode.externalApplication,
                                      );
                                    }
                                  },
                                ),
                              ],
                            ],
                          ),
                        );
                      }).toList(),
                    ),
                  ],
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
                    : (_showSavedOnly
                        ? '저장함 ${_savedItems.length}개'
                        : '추천 ${_items.length}개'),
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
                _showSavedOnly ? '저장한 후보만 표시 중' : '채우기 시 기존 추천 목록은 교체됩니다',
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
                final sourcePrice = it['sourcePrice'];
                final shippingFee = it['shippingFee'];
                final profit = (it['profit'] ?? 0);
                final marginRate = (it['marginRate'] ?? 0);
                final finalPrice = (it['finalPrice'] ?? 0);
                final reason = (it['reason'] ?? '').toString();
                final url = (it['sourceUrl'] ?? '').toString();
                final previewImagesAll = _previewImagesOf(it, max: 0);
                final previewImages = previewImagesAll.take(6).toList();
                final qc = (it['qc'] as Map?)?.cast<String, dynamic>() ??
                    const <String, dynamic>{};
                final qcTier = (qc['tier'] ?? '-').toString();
                final eligibleUpload = qc['eligibleUpload'] == true;
                final detailImageCountRaw = int.tryParse(
                        (it['contentImageCount'] ?? qc['detailImageCount'] ?? 0)
                            .toString()) ??
                    0;
                final detailImageCount = previewImagesAll.isNotEmpty
                    ? previewImagesAll.length
                    : detailImageCountRaw;

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
                                seed: it,
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
                                  label: eligibleUpload ? '업로드 가능' : 'QC 검토',
                                  color: eligibleUpload
                                      ? const Color(0xFF2F9E44)
                                      : Colors.orange,
                                ),
                                InfoChip(
                                  label: '권장가 ${_won(finalPrice)}',
                                  color: Theme.of(context).colorScheme.primary,
                                ),
                                InfoChip(
                                  label: '원가 ${_won(sourcePrice)}',
                                  color:
                                      Theme.of(context).colorScheme.secondary,
                                ),
                                if (num.tryParse(
                                        (shippingFee ?? '').toString()) !=
                                    null)
                                  InfoChip(
                                    label: '배송비 ${_won(shippingFee)}',
                                    color:
                                        Theme.of(context).colorScheme.outline,
                                  ),
                                InfoChip(
                                  label: '순마진 ${_won(profit)}',
                                  color: const Color(0xFF2F9E44),
                                ),
                                InfoChip(
                                  label:
                                      '마진 ${(((marginRate as num)) * 100).round()}%',
                                  color: const Color(0xFF2F9E44),
                                ),
                                if (detailImageCount > 0)
                                  InfoChip(
                                    label: '상세 $detailImageCount장',
                                    color:
                                        Theme.of(context).colorScheme.tertiary,
                                  ),
                              ],
                            ),
                            if (previewImages.isNotEmpty) ...[
                              const SizedBox(height: 8),
                              SizedBox(
                                height: 44,
                                child: ListView.separated(
                                  scrollDirection: Axis.horizontal,
                                  itemCount: previewImages.length,
                                  separatorBuilder: (_, __) =>
                                      const SizedBox(width: 6),
                                  itemBuilder: (ctx, pi) {
                                    final pu = previewImages[pi];
                                    return ClipRRect(
                                      borderRadius: BorderRadius.circular(8),
                                      child: Image.network(
                                        widget.api.proxyImageUrl(pu),
                                        width: 44,
                                        height: 44,
                                        fit: BoxFit.cover,
                                        errorBuilder: (_, __, ___) => Container(
                                          width: 44,
                                          height: 44,
                                          color: Theme.of(context)
                                              .colorScheme
                                              .surfaceContainerHighest,
                                          child: Icon(
                                            Icons.broken_image_outlined,
                                            size: 16,
                                            color: Theme.of(context)
                                                .colorScheme
                                                .onSurface
                                                .withValues(alpha: 0.5),
                                          ),
                                        ),
                                      ),
                                    );
                                  },
                                ),
                              ),
                            ],
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
                                                seed: it,
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
