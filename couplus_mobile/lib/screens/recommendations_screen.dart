import 'dart:convert';

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
  static const List<Map<String, String>> _fallbackRecoCategories = [
    {
      'key': 'all',
      'label': '전체 (기본)',
      'description': '기본 키워드셋 전체 사용',
    },
    {
      'key': 'car',
      'label': '차량용 전체',
      'description': '차량 수납/거치/선정리 통합',
    },
    {
      'key': 'car_storage',
      'label': '차량 수납',
      'description': '트렁크/시트백/콘솔 정리',
    },
    {
      'key': 'car_mount',
      'label': '차량 거치',
      'description': '휴대폰/태블릿 거치 위주',
    },
    {
      'key': 'car_cable',
      'label': '차량 케이블 정리',
      'description': '충전선/선고정/클립 위주',
    },
    {
      'key': 'pet',
      'label': '반려동물 전체',
      'description': '산책/그루밍/놀이 통합',
    },
    {
      'key': 'pet_walk',
      'label': '반려동물 산책',
      'description': '하네스/리드줄/배변용품',
    },
    {
      'key': 'pet_groom',
      'label': '반려동물 그루밍',
      'description': '브러쉬/털관리/목욕보조',
    },
    {
      'key': 'pet_toy',
      'label': '반려동물 장난감',
      'description': '강아지/고양이 놀이용품',
    },
    {
      'key': 'home',
      'label': '생활/수납 전체',
      'description': '주방/욕실/세탁/옷장/현관/거실/청소',
    },
    {
      'key': 'kitchen_storage',
      'label': '주방 수납',
      'description': '싱크대/냉장고/서랍 정리',
    },
    {
      'key': 'bathroom_storage',
      'label': '욕실 수납',
      'description': '욕실 선반/칫솔꽂이/타월걸이',
    },
    {
      'key': 'laundry_storage',
      'label': '세탁실 정리',
      'description': '세제/빨래/틈새수납',
    },
    {
      'key': 'closet_storage',
      'label': '옷장/서랍 정리',
      'description': '압축팩/칸막이/보관함',
    },
    {
      'key': 'entryway_storage',
      'label': '현관/신발장 정리',
      'description': '우산꽂이/신발수납/도어후크',
    },
    {
      'key': 'living_storage',
      'label': '거실 정리',
      'description': '리모컨/소파/테이블 수납',
    },
    {
      'key': 'cleaning_tools',
      'label': '청소도구 정리',
      'description': '밀대/빗자루/브러쉬 거치',
    },
    {
      'key': 'desk',
      'label': '데스크/사무 전체',
      'description': '케이블/책상수납 통합',
    },
    {
      'key': 'desk_cable',
      'label': '데스크 케이블 정리',
      'description': '멀티탭/전선/케이블클립',
    },
    {
      'key': 'desk_storage',
      'label': '책상 수납',
      'description': '모니터받침/서랍/문서정리',
    },
    {
      'key': 'outdoor',
      'label': '여행/캠핑 전체',
      'description': '여행파우치/차박/캠핑수납 통합',
    },
    {
      'key': 'travel_pouch',
      'label': '여행 파우치',
      'description': '캐리어/소분/압축 파우치',
    },
    {
      'key': 'camping_storage',
      'label': '캠핑/차박 수납',
      'description': '캠핑박스/행잉/트렁크 정리',
    },
  ];
  static const List<Map<String, String>> _sortOptions = [
    {'key': 'default', 'label': '기본 추천순'},
    {'key': 'seo_desc', 'label': 'SEO 점수 높은순'},
    {'key': 'seo_asc', 'label': 'SEO 점수 낮은순'},
  ];

  bool _loading = false;
  bool _loadingRecoCategories = false;
  String? _error;
  String? _lastRunSummary;
  String? _lastUploadSummary;
  DateTime? _lastUploadAt;
  List<Map<String, dynamic>> _lastUploadRows = const [];
  int _autoLimit = 5;
  bool _autoOnlyEligible = true;
  bool _autoForce = false;
  String? _activeFillJobId;
  Map<String, dynamic>? _fillProgress;
  DateTime? _fillStartedAt;
  String? _activeUploadJobId;
  Map<String, dynamic>? _uploadProgress;
  DateTime? _uploadStartedAt;
  List<Map<String, dynamic>> _items = const [];
  List<Map<String, dynamic>> _savedItems = const [];
  final Set<String> _savedUrls = <String>{};
  bool _showSavedOnly = false;
  final Set<String> _selected = <String>{};
  List<Map<String, String>> _recoCategories =
      List<Map<String, String>>.from(_fallbackRecoCategories);
  String _selectedRecoCategoryKey = 'all';
  String _selectedSortKey = 'default';
  bool _marketingBusy = false;
  String _marketingCampaign = '';
  String _marketingTone = '실용적';
  final Map<String, Map<String, dynamic>> _marketingLinkBySourceUrl =
      <String, Map<String, dynamic>>{};
  final Map<String, int> _marketingClickCountBySlug = <String, int>{};
  final TextEditingController _igUserIdCtrl = TextEditingController();
  final TextEditingController _igAccessTokenCtrl = TextEditingController();
  final TextEditingController _igPageIdCtrl = TextEditingController();
  Map<String, dynamic>? _instagramStatus;
  Map<String, dynamic>? _instagramFormat;
  Map<String, dynamic>? _lastReelsPackResponse;
  String? _lastManualUploadGuide;

  num? _seoScoreOf(Map<String, dynamic> item) {
    return num.tryParse((item['seoScore'] ?? '').toString());
  }

  num _recommendScoreOf(Map<String, dynamic> item) {
    return num.tryParse((item['score'] ?? '').toString()) ?? 0;
  }

  bool _isEligibleUploadItem(Map<String, dynamic> item) {
    final qc = (item['qc'] as Map?)?.cast<String, dynamic>() ??
        const <String, dynamic>{};
    return qc['eligibleUpload'] == true;
  }

  List<Map<String, dynamic>> _onlyEligibleItems(
    List<Map<String, dynamic>> source,
  ) {
    return source.where(_isEligibleUploadItem).toList();
  }

  List<Map<String, dynamic>> get _visibleItems {
    final source = _showSavedOnly
        ? _onlyEligibleItems(_savedItems)
        : _onlyEligibleItems(_items);
    if (_selectedSortKey == 'default') return source;
    final sorted = List<Map<String, dynamic>>.from(source);
    sorted.sort((a, b) {
      final sa = _seoScoreOf(a);
      final sb = _seoScoreOf(b);
      if (sa == null && sb == null) {
        return _recommendScoreOf(b).compareTo(_recommendScoreOf(a));
      }
      if (sa == null) return 1;
      if (sb == null) return -1;
      if (_selectedSortKey == 'seo_asc') {
        final cmp = sa.compareTo(sb);
        if (cmp != 0) return cmp;
      } else {
        final cmp = sb.compareTo(sa);
        if (cmp != 0) return cmp;
      }
      return _recommendScoreOf(b).compareTo(_recommendScoreOf(a));
    });
    return sorted;
  }

  @override
  void dispose() {
    _igUserIdCtrl.dispose();
    _igAccessTokenCtrl.dispose();
    _igPageIdCtrl.dispose();
    super.dispose();
  }

  String _nowLabel() {
    final n = DateTime.now();
    final hh = n.hour.toString().padLeft(2, '0');
    final mm = n.minute.toString().padLeft(2, '0');
    final ss = n.second.toString().padLeft(2, '0');
    return '$hh:$mm:$ss';
  }

  String _normalizeRecoCategoryKey(dynamic raw) {
    final text = raw.toString().trim().toLowerCase();
    if (text.isEmpty) return '';
    return text.replaceAll(RegExp(r'[^a-z0-9_-]'), '');
  }

  bool _hasRecoCategoryKey(String key) {
    return _recoCategories.any((row) => (row['key'] ?? '') == key);
  }

  String _selectedRecoCategoryLabel() {
    for (final row in _recoCategories) {
      if ((row['key'] ?? '') == _selectedRecoCategoryKey) {
        final label = (row['label'] ?? '').trim();
        if (label.isNotEmpty) return label;
      }
    }
    return '전체 (기본)';
  }

  String _defaultMarketingCampaign() {
    final now = DateTime.now();
    final y = now.year.toString();
    final m = now.month.toString().padLeft(2, '0');
    final d = now.day.toString().padLeft(2, '0');
    return 'ig_reels_$y$m$d';
  }

  String _marketingTargetUrlOf(Map<String, dynamic> item) {
    final candidates = <dynamic>[
      item['productUrl'],
      item['coupangUrl'],
      item['targetUrl'],
      item['sourceUrl'],
    ];
    for (final raw in candidates) {
      final text = raw.toString().trim();
      if (text.startsWith('http://') || text.startsWith('https://')) {
        return text;
      }
    }
    return '';
  }

  bool _hasInstagramPageConfigOrConnection() {
    if (_igPageIdCtrl.text.trim().isNotEmpty) return true;
    final status = _instagramStatus ?? const <String, dynamic>{};
    final page = (status['page'] as Map?)?.cast<String, dynamic>() ??
        const <String, dynamic>{};
    return (page['id'] ?? '').toString().trim().isNotEmpty;
  }

  Future<void> _copyText(String text, String message) async {
    final value = text.trim();
    if (value.isEmpty) return;
    await Clipboard.setData(ClipboardData(text: value));
    if (!mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(message)),
    );
  }

  Future<void> _openExternalUrl(String rawUrl) async {
    final uri = Uri.tryParse(rawUrl);
    if (uri == null) return;
    final launched = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (launched || !mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('브라우저 열기 실패: $rawUrl')),
    );
  }

  Widget _buildConnectionChecklistItem({
    required bool done,
    required String title,
    required String hint,
  }) {
    final color = done ? const Color(0xFF2F9E44) : Colors.orange;
    return Padding(
      padding: const EdgeInsets.only(bottom: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            done ? Icons.check_circle : Icons.radio_button_unchecked,
            size: 16,
            color: color,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                      fontSize: 13, fontWeight: FontWeight.w700),
                ),
                const SizedBox(height: 2),
                Text(
                  hint,
                  style: TextStyle(
                    fontSize: 12,
                    color: Theme.of(context)
                        .colorScheme
                        .onSurface
                        .withValues(alpha: 0.7),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  List<String> _videoPromptListFromPack(Map<String, dynamic> pack) {
    final soraPrompts = ((pack['soraVideoPrompts'] as List?) ?? const [])
        .map((e) => e.toString().trim())
        .where((e) => e.isNotEmpty)
        .toList();
    if (soraPrompts.isNotEmpty) return soraPrompts;
    return ((pack['grokVideoPrompts'] as List?) ?? const [])
        .map((e) => e.toString().trim())
        .where((e) => e.isNotEmpty)
        .toList();
  }

  String _videoPromptTextFromPackResponse(Map<String, dynamic> json) {
    final items = (json['items'] as List?) ?? const [];
    final prompts = <String>[];
    for (final raw in items) {
      if (raw is! Map) continue;
      final row = raw.cast<String, dynamic>();
      final pack = (row['pack'] as Map?)?.cast<String, dynamic>() ??
          const <String, dynamic>{};
      prompts.addAll(_videoPromptListFromPack(pack));
    }
    return prompts.join('\n\n---\n\n');
  }

  String _manualUploadGuideFromPackResponse(Map<String, dynamic> json) {
    final items = (json['items'] as List?) ?? const [];
    final lines = <String>[];
    var fallbackIndex = 1;
    final recommendedSec = int.tryParse(
          (((_instagramFormat?['durationSec'] as Map?)?['recommended'] ?? 20))
              .toString(),
        ) ??
        20;

    lines.add('캠페인: ${(json['campaign'] ?? '').toString().trim()}');
    lines.add('톤: ${(json['tone'] ?? '').toString().trim()}');
    lines.add(
      '권장 포맷: ${(_instagramFormat?['ratio'] ?? '9:16')} / '
      '${(_instagramFormat?['resolution'] ?? '1080x1920')} / $recommendedSec초',
    );
    lines.add('운영 메모: 페이지 생성이 막혀도 추적 링크 + 수동 게시로 먼저 유입 검증이 가능합니다.');

    for (final raw in items) {
      if (raw is! Map) continue;
      final row = raw.cast<String, dynamic>();
      final index = int.tryParse((row['index'] ?? 0).toString()) ?? 0;
      final item = (row['item'] as Map?)?.cast<String, dynamic>() ??
          const <String, dynamic>{};
      final tracking = (row['tracking'] as Map?)?.cast<String, dynamic>() ??
          const <String, dynamic>{};
      final pack = (row['pack'] as Map?)?.cast<String, dynamic>() ??
          const <String, dynamic>{};

      final title = (item['title'] ?? '').toString().trim();
      final hooks = ((pack['hooks'] as List?) ?? const [])
          .map((e) => e.toString().trim())
          .where((e) => e.isNotEmpty)
          .toList();
      final captions = ((pack['captions'] as List?) ?? const [])
          .map((e) => e.toString().trim())
          .where((e) => e.isNotEmpty)
          .toList();
      final instagramPostText =
          (pack['instagramPostText'] ?? '').toString().trim();
      final commentCtaText = (pack['commentCtaText'] ?? '').toString().trim();
      final commentReplyTemplate =
          (pack['commentReplyTemplate'] ?? '').toString().trim();
      final dmReplyTemplate = (pack['dmReplyTemplate'] ?? '').toString().trim();
      final manychatKeyword =
          (pack['manychatTriggerKeyword'] ?? pack['commentKeyword'] ?? '')
              .toString()
              .trim();
      final manychatPublicReplies =
          ((pack['manychatPublicReplies'] as List?) ?? const [])
              .map((e) => e.toString().trim())
              .where((e) => e.isNotEmpty)
              .toList();
      final manychatOpeningDm =
          (pack['manychatOpeningDm'] ?? '').toString().trim();
      final manychatButtonLabel =
          (pack['manychatButtonLabel'] ?? '').toString().trim();
      final manychatButtonUrl =
          (pack['manychatButtonUrl'] ?? '').toString().trim();
      final manychatSetupGuide =
          ((pack['manychatSetupGuide'] as List?) ?? const [])
              .map((e) => e.toString().trim())
              .where((e) => e.isNotEmpty)
              .toList();
      final bgmGuideText = (pack['bgmGuideText'] ?? '').toString().trim();
      final bgmSearchKeywords =
          ((pack['bgmSearchKeywords'] as List?) ?? const [])
              .map((e) => e.toString().trim())
              .where((e) => e.isNotEmpty)
              .toList();
      final referenceImageGuide =
          ((pack['referenceImageGuide'] as List?) ?? const [])
              .map((e) => e.toString().trim())
              .where((e) => e.isNotEmpty)
              .toList();
      final productFeatureHints =
          ((pack['productFeatureHints'] as List?) ?? const [])
              .map((e) => e.toString().trim())
              .where((e) => e.isNotEmpty)
              .toList();
      final hashtags = ((pack['hashtags'] as List?) ?? const [])
          .map((e) => e.toString().trim())
          .where((e) => e.isNotEmpty)
          .toList();
      final thumbnailTexts = ((pack['thumbnailTexts'] as List?) ?? const [])
          .map((e) => e.toString().trim())
          .where((e) => e.isNotEmpty)
          .toList();
      final storyboardVariants = (pack['storyboards'] as List?) ?? const [];
      final firstStoryboard =
          storyboardVariants.isNotEmpty && storyboardVariants.first is List
              ? (storyboardVariants.first as List)
                  .map((e) => e.toString().trim())
                  .where((e) => e.isNotEmpty)
                  .toList()
              : const <String>[];
      final trackingUrl = (tracking['trackingUrl'] ?? '').toString().trim();
      final displayIndex = index > 0 ? index : fallbackIndex++;

      lines.add('');
      lines.add('[$displayIndex] ${title.isEmpty ? '상품' : title}');
      lines.add('업로드 순서');
      lines.add('1. 메인 이미지와 글씨 없는 디테일 상품컷 1~4장을 고릅니다.');
      lines.add('2. 세로 9:16 릴스를 열고 첫 2초에 훅 문구를 넣습니다.');
      if (hooks.isNotEmpty) {
        lines.add('3. 첫 문구: ${hooks.first}');
      }
      if (referenceImageGuide.isNotEmpty) {
        lines.add('Sora 입력 이미지 가이드');
        for (var i = 0; i < referenceImageGuide.length; i += 1) {
          lines.add('${i + 1}. ${referenceImageGuide[i]}');
        }
      }
      if (productFeatureHints.isNotEmpty) {
        lines.add('감지된 상품 특징');
        for (var i = 0; i < productFeatureHints.length; i += 1) {
          lines.add('${i + 1}. ${productFeatureHints[i]}');
        }
      }
      if (firstStoryboard.isNotEmpty) {
        lines.add('장면 구성');
        for (final scene in firstStoryboard) {
          lines.add(' - $scene');
        }
      }
      if (instagramPostText.isNotEmpty || captions.isNotEmpty) {
        lines.add('업로드 문안');
        lines.add(
            instagramPostText.isNotEmpty ? instagramPostText : captions.first);
      }
      if (hashtags.isNotEmpty) {
        lines.add('해시태그');
        lines.add(hashtags.join(' '));
      }
      if (commentCtaText.isNotEmpty) {
        lines.add('댓글 유도 문구');
        lines.add(commentCtaText);
      }
      if (commentReplyTemplate.isNotEmpty) {
        lines.add('댓글 답글 템플릿');
        lines.add(commentReplyTemplate);
      }
      if (dmReplyTemplate.isNotEmpty) {
        lines.add('DM 템플릿');
        lines.add(dmReplyTemplate);
      }
      if (manychatKeyword.isNotEmpty ||
          manychatPublicReplies.isNotEmpty ||
          manychatOpeningDm.isNotEmpty ||
          manychatSetupGuide.isNotEmpty) {
        lines.add('Manychat Free 댓글→DM');
        if (manychatKeyword.isNotEmpty) {
          lines.add('트리거 키워드');
          lines.add(manychatKeyword);
        }
        if (manychatPublicReplies.isNotEmpty) {
          lines.add('공개 답글 후보');
          for (var i = 0; i < manychatPublicReplies.length; i += 1) {
            lines.add('${i + 1}. ${manychatPublicReplies[i]}');
          }
        }
        if (manychatOpeningDm.isNotEmpty) {
          lines.add('오프닝 DM');
          lines.add(manychatOpeningDm);
        }
        if (manychatButtonLabel.isNotEmpty || manychatButtonUrl.isNotEmpty) {
          lines.add('DM 버튼');
          lines.add('${manychatButtonLabel.isEmpty ? '구매 링크 보기' : manychatButtonLabel} / ${manychatButtonUrl.isEmpty ? '-' : manychatButtonUrl}');
        }
        if (manychatSetupGuide.isNotEmpty) {
          lines.add('Manychat 설정 순서');
          for (var i = 0; i < manychatSetupGuide.length; i += 1) {
            lines.add('${i + 1}. ${manychatSetupGuide[i]}');
          }
        }
      }
      if (bgmSearchKeywords.isNotEmpty || bgmGuideText.isNotEmpty) {
        lines.add('추천 BGM');
        for (var i = 0; i < bgmSearchKeywords.length; i += 1) {
          lines.add('${i + 1}. ${bgmSearchKeywords[i]}');
        }
        if (bgmGuideText.isNotEmpty) {
          lines.add(bgmGuideText);
        }
      }
      if (trackingUrl.isNotEmpty) {
        lines.add('추적 링크');
        lines.add(trackingUrl);
      }
      if (thumbnailTexts.isNotEmpty) {
        lines.add('썸네일 문구');
        lines.add(thumbnailTexts.join(' / '));
      }
      lines.add('게시 체크');
      lines.add('고정댓글 또는 본문에 링크 안내 문구를 넣고, 게시 후 클릭 수를 다시 조회합니다.');
    }

    return lines.join('\n');
  }

  Future<void> _showManualUploadAssistDialog(Map<String, dynamic> json) async {
    final guide =
        (_lastManualUploadGuide ?? _manualUploadGuideFromPackResponse(json))
            .trim();
    final prompts = _videoPromptTextFromPackResponse(json).trim();
    final previewText = const JsonEncoder.withIndent('  ').convert(json);
    final guidePreview = guide.length > 14000
        ? '${guide.substring(0, 14000)}\n\n... (생략)'
        : guide;
    final jsonPreview = previewText.length > 4000
        ? '${previewText.substring(0, 4000)}\n\n... (생략)'
        : previewText;

    if (!mounted) return;
    await showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('릴스 수동 업로드 보조'),
        content: SizedBox(
          width: 760,
          child: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '현재는 Meta 업로드 자동화보다 수동 게시 보조가 더 빠른 실효안입니다. '
                  '아래 문안과 추적 링크를 그대로 써서 먼저 유입을 검증하세요.',
                  style: TextStyle(
                    fontSize: 12,
                    color: Theme.of(context)
                        .colorScheme
                        .onSurface
                        .withValues(alpha: 0.74),
                  ),
                ),
                const SizedBox(height: 10),
                SelectableText(
                  guidePreview,
                  style: const TextStyle(fontSize: 12, height: 1.45),
                ),
                const SizedBox(height: 12),
                Text(
                  '원본 응답 미리보기',
                  style: TextStyle(
                    fontSize: 12,
                    fontWeight: FontWeight.w800,
                    color: Theme.of(context).colorScheme.onSurface,
                  ),
                ),
                const SizedBox(height: 6),
                SelectableText(
                  jsonPreview,
                  style: const TextStyle(fontSize: 11, height: 1.35),
                ),
              ],
            ),
          ),
        ),
        actions: [
          if (prompts.isNotEmpty)
            TextButton.icon(
              onPressed: () async {
                await _copyText(prompts, 'Sora 영상 프롬프트를 복사했어요.');
              },
              icon: const Icon(Icons.movie_creation_outlined, size: 18),
              label: const Text('프롬프트 복사'),
            ),
          TextButton.icon(
            onPressed: () async {
              await _copyText(guide, '수동 업로드 보조 문안을 복사했어요.');
            },
            icon: const Icon(Icons.upload_file_outlined, size: 18),
            label: const Text('보조 문안 복사'),
          ),
          TextButton.icon(
            onPressed: () async {
              await _copyText(previewText, '원본 JSON을 복사했어요.');
            },
            icon: const Icon(Icons.code_outlined, size: 18),
            label: const Text('JSON 복사'),
          ),
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(),
            child: const Text('닫기'),
          ),
        ],
      ),
    );
  }

  Future<void> _createMarketingLinkForItem(
    Map<String, dynamic> item, {
    bool copyOnSuccess = true,
  }) async {
    final sourceUrl = (item['sourceUrl'] ?? '').toString().trim();
    final targetUrl = _marketingTargetUrlOf(item);
    if (targetUrl.isEmpty || sourceUrl.isEmpty) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('링크 생성 대상 URL이 비어 있습니다.')),
      );
      return;
    }
    final campaign = _marketingCampaign.trim().isNotEmpty
        ? _marketingCampaign.trim()
        : _defaultMarketingCampaign();
    setState(() => _marketingBusy = true);
    try {
      final json = await widget.api.postJson('/api/marketing/links', {
        'targetUrl': targetUrl,
        'sourceUrl': sourceUrl,
        'title': (item['title'] ?? item['seoTitle'] ?? '').toString().trim(),
        'platform': 'instagram',
        'campaign': campaign,
        'content': 'reco_card',
        'term': (item['keyword'] ?? '').toString().trim(),
      });
      final link = (json['link'] as Map?)?.cast<String, dynamic>() ??
          const <String, dynamic>{};
      final trackingUrl = (link['trackingUrl'] ?? '').toString().trim();
      final slug = (link['slug'] ?? '').toString().trim();
      if (trackingUrl.isNotEmpty) {
        setState(() {
          _marketingLinkBySourceUrl[sourceUrl] = link;
          if (slug.isNotEmpty &&
              !_marketingClickCountBySlug.containsKey(slug)) {
            _marketingClickCountBySlug[slug] = 0;
          }
        });
        if (copyOnSuccess) {
          await Clipboard.setData(ClipboardData(text: trackingUrl));
        }
      }
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            trackingUrl.isNotEmpty
                ? (copyOnSuccess ? '마케팅 링크 생성 + 복사 완료' : '마케팅 링크 생성 완료')
                : '마케팅 링크 생성 완료',
          ),
        ),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('마케팅 링크 생성 실패: $e')),
      );
    } finally {
      if (mounted) setState(() => _marketingBusy = false);
    }
  }

  Future<void> _refreshMarketingClicksForItem(Map<String, dynamic> item) async {
    final sourceUrl = (item['sourceUrl'] ?? '').toString().trim();
    final link =
        _marketingLinkBySourceUrl[sourceUrl] ?? const <String, dynamic>{};
    final slug = (link['slug'] ?? '').toString().trim();
    if (slug.isEmpty) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('먼저 마케팅 링크를 생성해 주세요.')),
      );
      return;
    }
    try {
      final json =
          await widget.api.getJson('/api/marketing/links/$slug/clicks', query: {
        'limit': '1',
      });
      final total = int.tryParse((json['total'] ?? 0).toString()) ?? 0;
      if (!mounted) return;
      setState(() {
        _marketingClickCountBySlug[slug] = total;
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('클릭 $total건')),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('클릭 조회 실패: $e')),
      );
    }
  }

  Future<void> _generateReelsPackForSelected() async {
    final visibleUrls = _visibleItems
        .map((it) => (it['sourceUrl'] ?? '').toString().trim())
        .where((u) => u.isNotEmpty)
        .toSet();
    final urls = _selected.where(visibleUrls.contains).take(12).toList();
    if (urls.isEmpty) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('선택한 상품이 없어요.')),
      );
      return;
    }
    final byUrl = <String, Map<String, dynamic>>{};
    for (final it in _visibleItems) {
      final u = (it['sourceUrl'] ?? '').toString().trim();
      if (u.isEmpty) continue;
      byUrl[u] = it;
    }
    final picked =
        urls.map((u) => byUrl[u]).whereType<Map<String, dynamic>>().toList();
    if (picked.isEmpty) return;

    final campaign = _marketingCampaign.trim().isNotEmpty
        ? _marketingCampaign.trim()
        : _defaultMarketingCampaign();
    setState(() => _marketingBusy = true);
    try {
      final payload = {
        'platform': 'instagram',
        'campaign': campaign,
        'brand': '쿠팡코끼리',
        'tone': _marketingTone,
        'autoCreateLinks': true,
        'items': picked
            .map((it) => {
                  'title':
                      (it['title'] ?? it['seoTitle'] ?? '').toString().trim(),
                  'keyword': (it['keyword'] ?? '').toString().trim(),
                  'targetUrl': _marketingTargetUrlOf(it),
                  'sourceUrl': (it['sourceUrl'] ?? '').toString().trim(),
                  'category': (it['categoryLabel'] ?? '').toString().trim(),
                })
            .toList(),
      };
      final json =
          await widget.api.postJson('/api/marketing/reels/pack', payload);
      final count = int.tryParse((json['count'] ?? 0).toString()) ?? 0;
      final rows = (json['items'] as List?) ?? const [];
      final prompts = <String>[];

      for (final raw in rows) {
        if (raw is! Map) continue;
        final row = raw.cast<String, dynamic>();
        final itemMap = (row['item'] as Map?)?.cast<String, dynamic>() ??
            const <String, dynamic>{};
        final sourceUrl = (itemMap['sourceUrl'] ?? '').toString().trim();
        final tracking = (row['tracking'] as Map?)?.cast<String, dynamic>() ??
            const <String, dynamic>{};
        final pack = (row['pack'] as Map?)?.cast<String, dynamic>() ??
            const <String, dynamic>{};
        final videoPrompts = _videoPromptListFromPack(pack);
        if (videoPrompts.isNotEmpty) {
          prompts.addAll(videoPrompts);
        }
        if (sourceUrl.isNotEmpty && tracking.isNotEmpty) {
          _marketingLinkBySourceUrl[sourceUrl] = tracking;
          final slug = (tracking['slug'] ?? '').toString().trim();
          if (slug.isNotEmpty &&
              !_marketingClickCountBySlug.containsKey(slug)) {
            _marketingClickCountBySlug[slug] = 0;
          }
        }
      }

      final manualGuide = _manualUploadGuideFromPackResponse(json);

      if (prompts.isNotEmpty) {
        await Clipboard.setData(
            ClipboardData(text: prompts.join('\n\n---\n\n')));
      }

      if (!mounted) return;
      setState(() {
        _lastReelsPackResponse = json;
        _lastManualUploadGuide = manualGuide;
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(
            prompts.isNotEmpty
                ? 'Reels 팩 $count건 생성 완료 (프롬프트 복사됨)'
                : 'Reels 팩 $count건 생성 완료',
          ),
        ),
      );
      await _showManualUploadAssistDialog(json);
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('Reels 팩 생성 실패: $e')),
      );
    } finally {
      if (mounted) setState(() => _marketingBusy = false);
    }
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

  bool _isJobNotFoundError(Object e) {
    if (e is! ApiException) return false;
    if (e.statusCode != 404) return false;
    return e.message.trim().toLowerCase() == 'job_not_found';
  }

  bool _isTransientJobPollError(Object e) {
    if (e is! ApiException) return false;
    const transientCodes = <int>{502, 503, 504, 520, 521, 522, 523, 524};
    if (transientCodes.contains(e.statusCode)) return true;
    final details = (e.details ?? '').trimLeft().toLowerCase();
    final looksHtml =
        details.startsWith('<!doctype html') || details.startsWith('<html');
    final isInvalidJson = e.message.trim().toLowerCase() == 'invalid json';
    return looksHtml && isInvalidJson;
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
      case 'stopping':
        return '중단 요청됨: 현재 작업 단위(상품/키워드) 마무리 후 멈춥니다.';
      case 'stopped':
        final count = int.tryParse((progress['count'] ?? 0).toString()) ?? 0;
        return '중단됨: 현재까지 $count개 수집';
      case 'detached':
        return '작업 추적 연결이 끊겨 목록 동기화로 전환됨';
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
    final percent = num.tryParse((progress['percent'] ?? '').toString());
    if (percent != null) {
      final bounded = percent.toDouble();
      if (bounded <= 0) return 0;
      if (bounded >= 100) return 1;
      return bounded / 100.0;
    }
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

  String _uploadProgressMessage(Map<String, dynamic> progress) {
    final stage = (progress['stage'] ?? '').toString().trim().toLowerCase();
    final total = int.tryParse((progress['total'] ?? 0).toString()) ?? 0;
    final done = int.tryParse((progress['doneCount'] ?? 0).toString()) ?? 0;
    final uploaded = int.tryParse((progress['uploaded'] ?? 0).toString()) ?? 0;
    final skipped = int.tryParse((progress['skipped'] ?? 0).toString()) ?? 0;
    final failed = int.tryParse((progress['failed'] ?? 0).toString()) ?? 0;
    final currentUrl = (progress['currentUrl'] ?? '').toString().trim();
    switch (stage) {
      case 'queued':
        return total > 0 ? '업로드 대기열 등록 완료 (총 $total건)' : '업로드 대기열 등록 완료';
      case 'start':
        return total > 0 ? '업로드 시작 준비 중 (총 $total건)' : '업로드 시작 준비 중';
      case 'uploading':
        final current = currentUrl.isNotEmpty
            ? ' · ${currentUrl.length > 42 ? '${currentUrl.substring(0, 42)}…' : currentUrl}'
            : '';
        return '업로드 진행 중: $done/$total · 성공 $uploaded · 스킵 $skipped · 실패 $failed$current';
      case 'stopping':
        return '중단 요청됨: 현재 상품 처리 후 중단합니다.';
      case 'stopped':
        return '중단됨: 완료 $done/$total · 성공 $uploaded · 스킵 $skipped · 실패 $failed';
      case 'detached':
        return '작업 추적 연결이 끊겨 목록 동기화로 전환됨';
      case 'done':
        return '완료: 총 $done/$total · 성공 $uploaded · 스킵 $skipped · 실패 $failed';
      default:
        return '업로드 진행 중...';
    }
  }

  double? _uploadProgressRatio(Map<String, dynamic> progress) {
    final percent = num.tryParse((progress['percent'] ?? '').toString());
    if (percent != null) {
      final bounded = percent.toDouble();
      if (bounded <= 0) return 0;
      if (bounded >= 100) return 1;
      return bounded / 100.0;
    }
    final total = int.tryParse((progress['total'] ?? 0).toString()) ?? 0;
    final done = int.tryParse((progress['doneCount'] ?? 0).toString()) ?? 0;
    if (total <= 0) return null;
    final ratio = done / total;
    if (ratio <= 0) return 0;
    if (ratio >= 1) return 1;
    return ratio;
  }

  String _uploadElapsedLabel() {
    final started = _uploadStartedAt;
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

  List<String> _searchTagsOf(Map<String, dynamic> item, {int max = 6}) {
    final raw = (item['searchTags'] as List?) ?? const [];
    final out = <String>[];
    final seen = <String>{};
    for (final value in raw) {
      final tag = value.toString().trim();
      if (tag.isEmpty) continue;
      final key = tag.replaceAll(RegExp(r'\s+'), '').toLowerCase();
      if (key.isEmpty || seen.contains(key)) continue;
      seen.add(key);
      out.add(tag);
      if (max > 0 && out.length >= max) break;
    }
    return out;
  }

  Future<void> _loadMarketingLinks({bool silent = true}) async {
    try {
      final json = await widget.api.getJson('/api/marketing/links', query: {
        'limit': '300',
        'platform': 'instagram',
      });
      final rows = (json['items'] as List?) ?? const [];
      final nextLinks = <String, Map<String, dynamic>>{};
      final nextClicks = <String, int>{};
      for (final raw in rows) {
        if (raw is! Map) continue;
        final row = raw.cast<String, dynamic>();
        final sourceUrl = (row['sourceUrl'] ?? '').toString().trim();
        final slug = (row['slug'] ?? '').toString().trim();
        final clickCount =
            int.tryParse((row['clickCount'] ?? 0).toString()) ?? 0;
        if (sourceUrl.isNotEmpty) {
          nextLinks[sourceUrl] = row;
        }
        if (slug.isNotEmpty) {
          nextClicks[slug] = clickCount;
        }
      }
      if (!mounted) return;
      setState(() {
        _marketingLinkBySourceUrl
          ..clear()
          ..addAll(nextLinks);
        _marketingClickCountBySlug
          ..clear()
          ..addAll(nextClicks);
      });
    } catch (e) {
      if (!silent && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('마케팅 링크 로드 실패: $e')),
        );
      }
    }
  }

  Future<void> _loadInstagramConfig() async {
    try {
      final settingsJson = await widget.api.getJson('/api/settings');
      final settings =
          (settingsJson['settings'] as Map?)?.cast<String, dynamic>() ??
              const <String, dynamic>{};
      final igUserId = (settings['instagramIgUserId'] ?? '').toString().trim();
      final accessToken =
          (settings['instagramAccessToken'] ?? '').toString().trim();
      final pageId = (settings['instagramPageId'] ?? '').toString().trim();
      if (!mounted) return;
      setState(() {
        if (_igUserIdCtrl.text != igUserId) {
          _igUserIdCtrl.text = igUserId;
        }
        if (_igAccessTokenCtrl.text != accessToken) {
          _igAccessTokenCtrl.text = accessToken;
        }
        if (_igPageIdCtrl.text != pageId) {
          _igPageIdCtrl.text = pageId;
        }
      });
    } catch (_) {}
  }

  Future<void> _saveInstagramConfig() async {
    final igUserId = _igUserIdCtrl.text.trim();
    final accessToken = _igAccessTokenCtrl.text.trim();
    final pageId = _igPageIdCtrl.text.trim();
    try {
      setState(() => _marketingBusy = true);
      await widget.api.postJson('/api/settings', {
        'instagramIgUserId': igUserId,
        'instagramAccessToken': accessToken,
        'instagramPageId': pageId,
      });
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('인스타 설정 저장 완료')),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('인스타 설정 저장 실패: $e')),
      );
    } finally {
      if (mounted) setState(() => _marketingBusy = false);
    }
  }

  Future<void> _checkInstagramConnection() async {
    try {
      setState(() => _marketingBusy = true);
      final json = await widget.api.getJson('/api/instagram/connection/status');
      if (!mounted) return;
      setState(() {
        _instagramStatus = json;
      });
      final connected = json['connected'] == true;
      final msg = connected
          ? '인스타 계정 연결 확인 완료'
          : '인스타 연결 실패: ${(json['error'] ?? json['reason'] ?? 'unknown').toString()}';
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(msg)));
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('인스타 연결 확인 실패: $e')),
      );
    } finally {
      if (mounted) setState(() => _marketingBusy = false);
    }
  }

  Future<void> _loadInstagramFormat() async {
    try {
      final json = await widget.api.getJson('/api/instagram/reels/format');
      if (!mounted) return;
      setState(() {
        _instagramFormat = (json['format'] as Map?)?.cast<String, dynamic>() ??
            const <String, dynamic>{};
      });
    } catch (_) {}
  }

  Future<void> _loadRecoCategories() async {
    setState(() => _loadingRecoCategories = true);
    try {
      final json = await widget.api.getJson('/api/recommendations/categories');
      final rows = (json['categories'] as List?) ?? const [];
      final next = <Map<String, String>>[];

      for (final raw in rows) {
        if (raw is! Map) continue;
        final map = raw.cast<String, dynamic>();
        final key = _normalizeRecoCategoryKey(map['key']);
        if (key.isEmpty) continue;
        final label = (map['label'] ?? key).toString().trim();
        final description = (map['description'] ?? '').toString().trim();
        next.add({
          'key': key,
          'label': label.isEmpty ? key : label,
          'description': description,
        });
      }

      if (next.isEmpty) {
        next.addAll(_fallbackRecoCategories);
      }
      if (!next.any((row) => row['key'] == 'all')) {
        next.insert(0, const {
          'key': 'all',
          'label': '전체 (기본)',
          'description': '기본 키워드셋 전체 사용',
        });
      }

      if (!mounted) return;
      setState(() {
        _recoCategories = next;
        if (!_hasRecoCategoryKey(_selectedRecoCategoryKey)) {
          _selectedRecoCategoryKey = 'all';
        }
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _recoCategories =
            List<Map<String, String>>.from(_fallbackRecoCategories);
        if (!_hasRecoCategoryKey(_selectedRecoCategoryKey)) {
          _selectedRecoCategoryKey = 'all';
        }
      });
    } finally {
      if (mounted) {
        setState(() => _loadingRecoCategories = false);
      }
    }
  }

  @override
  void initState() {
    super.initState();
    _marketingCampaign = _defaultMarketingCampaign();
    _loadInstagramConfig();
    _loadInstagramFormat();
    _checkInstagramConnection();
    _loadMarketingLinks();
    _loadRecoCategories();
    _refresh();
  }

  Future<void> _refresh() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final recoJson = await widget.api.getJson('/api/recommendations', query: {
        'limit': '120',
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
      await _loadMarketingLinks();
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _reloadListQuietly() async {
    try {
      final recoJson = await widget.api.getJson('/api/recommendations', query: {
        'limit': '120',
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
      await _loadMarketingLinks();
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
    final targetByUrl = <String, Map<String, dynamic>>{};
    for (final item in targets) {
      final url = (item['sourceUrl'] ?? '').toString().trim();
      if (url.isEmpty || controllers.containsKey(url)) continue;
      targetByUrl[url] = item;
      controllers[url] = TextEditingController(
        text: (item['seoTitle'] ?? item['title'] ?? '').toString(),
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
        final url = entry.key;
        final item = targetByUrl[url] ?? const <String, dynamic>{};
        final nextTitle = entry.value.text.trim();
        final fallbackTitle =
            (item['seoTitle'] ?? item['title'] ?? '').toString().trim();
        final seedTitle =
            (nextTitle.isNotEmpty ? nextTitle : fallbackTitle).trim();
        final categoryCode =
            int.tryParse((item['categoryCode'] ?? '').toString());
        final keyword = (item['keyword'] ?? '').toString().trim();
        final override = <String, dynamic>{};
        if (nextTitle.isNotEmpty) {
          override['titleOverride'] = nextTitle;
        }
        if (seedTitle.isNotEmpty) {
          override['seedTitle'] = seedTitle;
        }
        if (keyword.isNotEmpty) {
          override['keyword'] = keyword;
        }
        if (categoryCode != null && categoryCode > 0) {
          override['categoryOverrideCode'] = categoryCode;
        }
        if (override.isNotEmpty) {
          overrides[url] = override;
        }
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
    final stopped = fill['stopped'] == true;
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
          ? (stopped
              ? '마지막 채우기 ${_nowLabel()} · 사용자 중단, 현재까지 $count개'
              : '마지막 채우기 ${_nowLabel()} · $count개 생성(이전 $removed개 교체)')
          : '마지막 채우기 ${_nowLabel()} · 결과 0개${hint.isNotEmpty ? " ($hint)" : ""}';
      _fillProgress = {
        'stage': stopped ? 'stopped' : (count > 0 ? 'done' : 'done_empty'),
        'percent': 100,
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
          stopped
              ? '추천 채우기 중단: 현재까지 $count개 반영'
              : count > 0
                  ? '추천 채우기 완료: 기존 $removed개 교체, 새 $count개 (재노출 제외 $cooldown일)'
                  : '추천 채우기 완료: 새 0개 (재노출 제외 $cooldown일)${hint.isNotEmpty ? " - $hint" : ""}',
        ),
      ),
    );
  }

  Future<Map<String, dynamic>?> _pollFillJob(String jobId) async {
    var transientErrorStreak = 0;
    for (var i = 0; i < 3600; i += 1) {
      await Future<void>.delayed(const Duration(seconds: 1));
      Map<String, dynamic> j;
      try {
        j = await widget.api.getJson('/api/jobs/$jobId');
      } on ApiException catch (e) {
        if (_isJobNotFoundError(e)) {
          return {
            'detached': true,
            'jobId': jobId,
          };
        }
        if (_isTransientJobPollError(e)) {
          transientErrorStreak += 1;
          if (transientErrorStreak <= 20) {
            continue;
          }
          throw Exception('서버 응답이 불안정합니다(일시 502/게이트웨이 오류). 잠시 후 다시 시도해 주세요.');
        }
        rethrow;
      }
      transientErrorStreak = 0;
      final job = (j['job'] as Map?)?.cast<String, dynamic>() ?? const {};
      final progress = (job['progress'] as Map?)?.cast<String, dynamic>() ??
          const <String, dynamic>{};
      if (mounted) {
        setState(() {
          _fillProgress = progress;
          final runningItems = (job['items'] as List?) ?? const [];
          if (runningItems.isNotEmpty) {
            _items = runningItems
                .map((e) => (e as Map).cast<String, dynamic>())
                .toList();
            _showSavedOnly = false;
            _selected.removeWhere((u) =>
                !_items.any((it) => (it['sourceUrl'] ?? '').toString() == u));
          }
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
      if (status == 'stopped') {
        final result = (job['result'] as Map?)?.cast<String, dynamic>() ?? {};
        if (result.isNotEmpty) return result;
        final fill = (job['fill'] as Map?)?.cast<String, dynamic>() ??
            const <String, dynamic>{};
        final items = (job['items'] as List?) ?? const [];
        return {
          'fill': {
            ...fill,
            'ok': true,
            'stopped': true,
            'count': fill['count'] ?? items.length,
          },
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

  Future<void> _requestStopFill() async {
    final jobId = (_activeFillJobId ?? '').trim();
    if (jobId.isEmpty) return;
    try {
      await widget.api.postJson('/api/jobs/$jobId/stop', const {});
      if (!mounted) return;
      setState(() {
        final next = <String, dynamic>{
          ...(_fillProgress ?? const <String, dynamic>{}),
          'stage': 'stopping',
        };
        _fillProgress = next;
      });
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('중단 요청을 보냈습니다. 현재 작업 단위 완료 후 멈춥니다.')),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('중단 요청 실패: $e')),
      );
    }
  }

  Future<void> _runNow() async {
    const fillTargetCount = 80;
    final categoryKey = _selectedRecoCategoryKey;
    final categoryLabel = _selectedRecoCategoryLabel();
    setState(() {
      _loading = true;
      _error = null;
      _fillStartedAt = DateTime.now();
      _fillProgress = const {'stage': 'queued', 'percent': 1};
      _items = const [];
      _selected.clear();
      _showSavedOnly = false;
      _lastRunSummary =
          '마지막 채우기 ${_nowLabel()} · [$categoryLabel] 기존 추천 비우고 새 목록 생성 시작';
    });
    try {
      Map<String, dynamic>? startJson;
      try {
        startJson =
            await widget.api.postJson('/api/recommendations/fill/start', {
          'targetCount': fillTargetCount,
          'categoryKey': categoryKey,
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
          setState(() {
            _lastRunSummary = '마지막 채우기 ${_nowLabel()} · 작업이 길어 백그라운드로 계속 진행 중';
          });
          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(
                content: Text('작업 시간이 길어 계속 진행 중입니다. 잠시 후 상태를 다시 확인하세요.'),
              ),
            );
          }
          return;
        }
        if (result['detached'] == true) {
          await _reloadListQuietly();
          if (!mounted) return;
          setState(() {
            _activeFillJobId = null;
            _fillProgress = const {
              'stage': 'detached',
              'percent': 100,
            };
            _lastRunSummary =
                '마지막 채우기 ${_nowLabel()} · 작업 추적 연결이 끊겨 목록 동기화로 전환';
            _error = null;
          });
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text(
                '작업 추적 연결이 끊겨 목록만 동기화했습니다. 필요하면 한 번 더 실행하세요.',
              ),
            ),
          );
          return;
        }
        await _applyFillResponse(result);
      } else {
        // Fallback for older server runtimes without async fill job endpoint.
        final json = await widget.api.postJson('/api/recommendations/fill', {
          'targetCount': fillTargetCount,
          'categoryKey': categoryKey,
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

  Future<void> _autoUpload() async {
    final limit = _autoLimit.clamp(1, 30).toInt();
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final json =
          await widget.api.postJson('/api/recommendations/auto-upload', {
        'limit': limit,
        'onlyEligible': _autoOnlyEligible ? '1' : '0',
        'force': _autoForce ? '1' : '0',
      });

      final summary =
          (json['summary'] as Map?)?.cast<String, dynamic>() ?? const {};
      final items = (json['items'] as List?) ?? const [];

      int asInt(dynamic v) {
        return int.tryParse((v ?? 0).toString()) ?? 0;
      }

      final requested = asInt(summary['requested']);
      final candidates = asInt(summary['candidates']);
      final uploaded = asInt(summary['uploaded']);
      final skipped = asInt(summary['skipped']);
      final failed = asInt(summary['failed']);
      final reasonCounts = <String, int>{};

      for (final raw in items) {
        final row = (raw as Map).cast<String, dynamic>();
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
        _lastUploadAt = DateTime.now();
        _lastUploadSummary =
            '자동 업로드 완료: 성공 $uploaded / 스킵 $skipped / 실패 $failed'
            ' (요청 $requested, 후보 $candidates)'
            '${reasonText.isNotEmpty ? ' · $reasonText' : ''}';
        _lastUploadRows = items
            .map((raw) => (raw as Map).cast<String, dynamic>())
            .take(12)
            .toList();
        _selected.clear();
      });

      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text('자동 업로드 완료: 성공 $uploaded / 스킵 $skipped / 실패 $failed'),
          ),
        );
      }

      await _reloadListQuietly();
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  // Upload is done from the detail preview screen.

  Future<void> _applyUploadResponse(
    Map<String, dynamic> json, {
    bool stopped = false,
  }) async {
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
      final sellerProductId = (row['sellerProductId'] ?? '').toString().trim();
      if (sellerProductId.isNotEmpty) {
        successIds.add(sellerProductId);
      }
      if (row['skipped'] == true || row['ok'] == false) {
        final reasonRaw =
            (row['skipReason'] ?? row['error'] ?? 'unknown').toString().trim();
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
      _activeUploadJobId = null;
      _uploadStartedAt = null;
      _uploadProgress = {
        'stage': stopped ? 'stopped' : 'done',
        'percent': 100,
        'doneCount': asInt(summary['total']),
        'total': asInt(summary['total']),
        'uploaded': uploaded,
        'skipped': skipped,
        'failed': failed,
      };
      _lastUploadAt = DateTime.now();
      _lastUploadSummary =
          '${stopped ? '다중 업로드 중단' : '다중 업로드 완료'}: 성공 $uploaded / 스킵 $skipped / 실패 $failed'
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
          content: Text(
            '${stopped ? '다중 업로드 중단' : '다중 업로드 완료'}: 성공 $uploaded / 스킵 $skipped / 실패 $failed',
          ),
        ),
      );
    }

    await _refresh();
  }

  Future<Map<String, dynamic>?> _pollUploadJob(String jobId) async {
    var transientErrorStreak = 0;
    for (var i = 0; i < 3600; i += 1) {
      await Future<void>.delayed(const Duration(seconds: 1));
      Map<String, dynamic> j;
      try {
        j = await widget.api.getJson('/api/jobs/$jobId');
      } on ApiException catch (e) {
        if (_isJobNotFoundError(e)) {
          return {
            'detached': true,
            'jobId': jobId,
          };
        }
        if (_isTransientJobPollError(e)) {
          transientErrorStreak += 1;
          if (transientErrorStreak <= 20) {
            continue;
          }
          throw Exception('서버 응답이 불안정합니다(일시 502/게이트웨이 오류). 잠시 후 다시 시도해 주세요.');
        }
        rethrow;
      }
      transientErrorStreak = 0;
      final job = (j['job'] as Map?)?.cast<String, dynamic>() ?? const {};
      final progress = (job['progress'] as Map?)?.cast<String, dynamic>() ??
          const <String, dynamic>{};
      final runningRows = (job['items'] as List?) ?? const [];
      if (mounted) {
        setState(() {
          _uploadProgress = progress;
          if (runningRows.isNotEmpty) {
            _lastUploadRows = runningRows
                .map((raw) => (raw as Map).cast<String, dynamic>())
                .take(12)
                .toList();
          }
        });
      }

      final status = (job['status'] ?? '').toString().toLowerCase();
      if (status == 'success' || status == 'done') {
        final result = (job['result'] as Map?)?.cast<String, dynamic>() ?? {};
        if (result.isNotEmpty) {
          return result;
        }
        final summary =
            (job['summary'] as Map?)?.cast<String, dynamic>() ?? const {};
        return {
          'summary': summary,
          'items': runningRows,
        };
      }
      if (status == 'stopped') {
        final result = (job['result'] as Map?)?.cast<String, dynamic>() ?? {};
        if (result.isNotEmpty) {
          return {
            ...result,
            'stopped': true,
          };
        }
        final summary =
            (job['summary'] as Map?)?.cast<String, dynamic>() ?? const {};
        return {
          'summary': summary,
          'items': runningRows,
          'stopped': true,
        };
      }
      if (status == 'failed') {
        final message = (job['errorMessage'] ?? job['error'] ?? '다중 업로드 실패')
            .toString()
            .trim();
        throw Exception(message.isEmpty ? '다중 업로드 실패' : message);
      }
    }
    return null;
  }

  Future<void> _requestStopUpload() async {
    final jobId = (_activeUploadJobId ?? '').trim();
    if (jobId.isEmpty) return;
    try {
      await widget.api.postJson('/api/jobs/$jobId/stop', const {});
      if (!mounted) return;
      setState(() {
        _uploadProgress = {
          ...(_uploadProgress ?? const <String, dynamic>{}),
          'stage': 'stopping',
        };
      });
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('업로드 중단 요청을 보냈습니다. 현재 상품 처리 후 중단합니다.')),
      );
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text('업로드 중단 요청 실패: $e')),
      );
    }
  }

  Future<void> _uploadSelected() async {
    final visibleUrls = _visibleItems
        .map((it) => (it['sourceUrl'] ?? '').toString().trim())
        .where((u) => u.isNotEmpty)
        .toSet();
    final urls = _selected.where(visibleUrls.contains).toList();
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
      _uploadStartedAt = DateTime.now();
      _uploadProgress = {
        'stage': 'queued',
        'percent': 1,
        'total': urls.length,
        'doneCount': 0,
        'uploaded': 0,
        'skipped': 0,
        'failed': 0,
      };
      _lastUploadSummary = '마지막 업로드 ${_nowLabel()} · 선택 ${urls.length}개 업로드 시작';
    });

    try {
      Map<String, dynamic>? startJson;
      try {
        startJson = await widget.api.postJson('/api/upload/bulk/start', {
          'urls': urls,
          'force': '0',
          if (overrides.isNotEmpty) 'overridesByUrl': overrides,
        });
      } on ApiException catch (e) {
        if (e.statusCode != 404) rethrow;
      }

      final job = (startJson?['job'] as Map?)?.cast<String, dynamic>() ?? {};
      final jobId = (job['id'] ?? '').toString().trim();
      if (jobId.isNotEmpty) {
        setState(() {
          _activeUploadJobId = jobId;
          _uploadProgress =
              (job['progress'] as Map?)?.cast<String, dynamic>() ??
                  const <String, dynamic>{'stage': 'queued'};
        });
        final result = await _pollUploadJob(jobId);
        if (result == null) {
          setState(() {
            _lastUploadSummary =
                '마지막 업로드 ${_nowLabel()} · 작업이 길어 백그라운드로 계속 진행 중';
          });
          if (mounted) {
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(
                content: Text('업로드 시간이 길어 계속 진행 중입니다. 잠시 후 상태를 다시 확인하세요.'),
              ),
            );
          }
          return;
        }
        if (result['detached'] == true) {
          await _reloadListQuietly();
          if (!mounted) return;
          setState(() {
            _activeUploadJobId = null;
            _uploadStartedAt = null;
            _uploadProgress = {
              'stage': 'detached',
              'percent': 100,
              'total': urls.length,
              'doneCount': 0,
              'uploaded': 0,
              'skipped': 0,
              'failed': 0,
            };
            _lastUploadSummary =
                '마지막 업로드 ${_nowLabel()} · 작업 추적 연결이 끊겨 목록 동기화로 전환';
            _error = null;
          });
          ScaffoldMessenger.of(context).showSnackBar(
            const SnackBar(
              content: Text(
                '업로드 작업 추적 연결이 끊겨 목록만 동기화했습니다. 필요하면 다시 실행하세요.',
              ),
            ),
          );
          return;
        }
        await _applyUploadResponse(result, stopped: result['stopped'] == true);
      } else {
        // Fallback for older server runtimes without async bulk endpoint.
        final json = await widget.api.postJson('/api/upload/bulk', {
          'urls': urls,
          'force': '0',
          if (overrides.isNotEmpty) 'overridesByUrl': overrides,
        });
        await _applyUploadResponse(json);
      }
    } catch (e) {
      setState(() {
        _error = e.toString();
        _activeUploadJobId = null;
      });
    } finally {
      if (mounted) {
        setState(() {
          _loading = false;
          if ((_activeUploadJobId ?? '').isEmpty) {
            _uploadStartedAt = null;
          }
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final visibleItems = _visibleItems;
    final visibleUrls = visibleItems
        .map((it) => (it['sourceUrl'] ?? '').toString().trim())
        .where((u) => u.isNotEmpty)
        .toSet();
    final selectedCount =
        _selected.where((u) => visibleUrls.contains(u)).length;
    final visibleRecoCount = _onlyEligibleItems(_items).length;
    final visibleSavedCount = _onlyEligibleItems(_savedItems).length;
    final hiddenRecoCount = (_items.length - visibleRecoCount).clamp(0, 99999);
    final fillStage = (_fillProgress?['stage'] ?? '').toString();
    final fillCount =
        int.tryParse((_fillProgress?['count'] ?? 0).toString()) ?? 0;
    final fillPercent =
        num.tryParse((_fillProgress?['percent'] ?? '').toString());
    final fillDone = fillStage == 'done' ||
        fillStage == 'done_empty' ||
        fillStage == 'stopped' ||
        fillStage == 'detached';
    final fillEmptyDone = fillStage == 'done_empty' ||
        fillStage == 'stopped' ||
        (fillStage == 'done' && fillCount <= 0);
    final fillRunning = ((_activeFillJobId ?? '').isNotEmpty && !fillDone) ||
        (_loading && _fillProgress != null && !fillDone);
    final uploadStage = (_uploadProgress?['stage'] ?? '').toString();
    final uploadPercent =
        num.tryParse((_uploadProgress?['percent'] ?? '').toString());
    final uploadDone = uploadStage == 'done' ||
        uploadStage == 'stopped' ||
        uploadStage == 'detached';
    final uploadRunning =
        ((_activeUploadJobId ?? '').isNotEmpty && !uploadDone) ||
            (_loading && _uploadProgress != null && !uploadDone);

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
          onPressed:
              fillRunning ? _requestStopFill : (_loading ? null : _runNow),
          icon:
              Icon(fillRunning ? Icons.stop_circle_outlined : Icons.autorenew),
          tooltip: fillRunning ? '중단(현재 작업 단위 마무리 후)' : '채우기(기존 목록 교체)',
        ),
      ],
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(
                      Icons.flash_on,
                      size: 18,
                      color: Theme.of(context).colorScheme.primary,
                    ),
                    const SizedBox(width: 8),
                    const Expanded(
                      child: Text(
                        '자동 업로드',
                        style: TextStyle(fontWeight: FontWeight.w800),
                      ),
                    ),
                    FilledButton.tonalIcon(
                      onPressed: _loading ? null : _autoUpload,
                      icon: const Icon(Icons.cloud_upload_outlined, size: 18),
                      label: const Text('실행'),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Wrap(
                  spacing: 10,
                  runSpacing: 8,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Text('대상 수'),
                        const SizedBox(width: 8),
                        DropdownButton<int>(
                          value: _autoLimit,
                          onChanged: _loading
                              ? null
                              : (value) {
                                  if (value == null) return;
                                  setState(() => _autoLimit = value);
                                },
                          items: const [3, 5, 10, 20, 30]
                              .map(
                                (n) => DropdownMenuItem<int>(
                                  value: n,
                                  child: Text('$n개'),
                                ),
                              )
                              .toList(),
                        ),
                      ],
                    ),
                    FilterChip(
                      label: const Text('적합상품만'),
                      selected: _autoOnlyEligible,
                      onSelected: _loading
                          ? null
                          : (v) {
                              setState(() => _autoOnlyEligible = v);
                            },
                    ),
                    FilterChip(
                      label: const Text('중복 강행(force)'),
                      selected: _autoForce,
                      onSelected: _loading
                          ? null
                          : (v) {
                              setState(() => _autoForce = v);
                            },
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.center,
                  children: [
                    Expanded(
                      child: InputDecorator(
                        decoration: const InputDecoration(
                          labelText: '추천 카테고리',
                          isDense: true,
                        ),
                        child: DropdownButtonHideUnderline(
                          child: DropdownButton<String>(
                            value: _hasRecoCategoryKey(_selectedRecoCategoryKey)
                                ? _selectedRecoCategoryKey
                                : 'all',
                            isExpanded: true,
                            onChanged: (_loading ||
                                    fillRunning ||
                                    _loadingRecoCategories)
                                ? null
                                : (value) {
                                    if (value == null) return;
                                    setState(() {
                                      _selectedRecoCategoryKey = value;
                                    });
                                  },
                            items: _recoCategories
                                .map(
                                  (row) => DropdownMenuItem<String>(
                                    value: (row['key'] ?? 'all'),
                                    child: Text((row['label'] ?? '전체 (기본)')),
                                  ),
                                )
                                .toList(),
                          ),
                        ),
                      ),
                    ),
                    if (_loadingRecoCategories) ...[
                      const SizedBox(width: 8),
                      SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: Theme.of(context).colorScheme.primary,
                        ),
                      ),
                    ],
                  ],
                ),
                const SizedBox(height: 10),
                InputDecorator(
                  decoration: const InputDecoration(
                    labelText: '목록 정렬',
                    isDense: true,
                  ),
                  child: DropdownButtonHideUnderline(
                    child: DropdownButton<String>(
                      value: _selectedSortKey,
                      isExpanded: true,
                      onChanged: _loading
                          ? null
                          : (value) {
                              if (value == null) return;
                              setState(() => _selectedSortKey = value);
                            },
                      items: _sortOptions
                          .map(
                            (row) => DropdownMenuItem<String>(
                              value: row['key'],
                              child: Text(row['label'] ?? '기본 추천순'),
                            ),
                          )
                          .toList(),
                    ),
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  '채우기(우측 상단 새로고침)는 선택한 카테고리 기준으로 추천을 생성합니다. 자동 업로드는 현재 목록 상위 항목에 적용되며, 목록 정렬은 화면 표시 순서에만 반영됩니다.',
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
          ),
          const SizedBox(height: 10),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Icon(
                      Icons.campaign_outlined,
                      size: 18,
                      color: Theme.of(context).colorScheme.primary,
                    ),
                    const SizedBox(width: 8),
                    const Expanded(
                      child: Text(
                        '인스타 마케팅',
                        style: TextStyle(fontWeight: FontWeight.w800),
                      ),
                    ),
                    FilledButton.tonalIcon(
                      onPressed:
                          (_loading || _marketingBusy || selectedCount <= 0)
                              ? null
                              : _generateReelsPackForSelected,
                      icon: const Icon(Icons.movie_creation_outlined, size: 18),
                      label: Text(selectedCount > 0
                          ? '선택 $selectedCount개 릴스팩'
                          : '선택 릴스팩'),
                    ),
                  ],
                ),
                const SizedBox(height: 10),
                Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(10),
                    color: Theme.of(context)
                        .colorScheme
                        .surfaceContainerHighest
                        .withValues(alpha: 0.35),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          const Text(
                            '인스타 계정 연결',
                            style: TextStyle(fontWeight: FontWeight.w800),
                          ),
                          const SizedBox(width: 8),
                          InfoChip(
                            label: (_instagramStatus?['connected'] == true)
                                ? '연결됨'
                                : '미연결',
                            color: (_instagramStatus?['connected'] == true)
                                ? const Color(0xFF2F9E44)
                                : Colors.orange,
                          ),
                          const Spacer(),
                          TextButton.icon(
                            onPressed: (_loading || _marketingBusy)
                                ? null
                                : _checkInstagramConnection,
                            icon: const Icon(Icons.verified_outlined, size: 18),
                            label: const Text('연결 확인'),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      TextFormField(
                        controller: _igUserIdCtrl,
                        onChanged: (_) => setState(() {}),
                        decoration: const InputDecoration(
                          labelText: 'Instagram User ID',
                          isDense: true,
                        ),
                      ),
                      const SizedBox(height: 8),
                      TextFormField(
                        controller: _igPageIdCtrl,
                        onChanged: (_) => setState(() {}),
                        decoration: const InputDecoration(
                          labelText: 'Facebook Page ID (선택)',
                          isDense: true,
                        ),
                      ),
                      const SizedBox(height: 8),
                      TextFormField(
                        controller: _igAccessTokenCtrl,
                        onChanged: (_) => setState(() {}),
                        decoration: const InputDecoration(
                          labelText: 'Instagram Access Token',
                          isDense: true,
                        ),
                        maxLines: 2,
                      ),
                      const SizedBox(height: 8),
                      Row(
                        children: [
                          FilledButton.tonalIcon(
                            onPressed: (_loading || _marketingBusy)
                                ? null
                                : _saveInstagramConfig,
                            icon: const Icon(Icons.save_outlined, size: 18),
                            label: const Text('설정 저장'),
                          ),
                          const SizedBox(width: 8),
                          TextButton.icon(
                            onPressed: (_loading || _marketingBusy)
                                ? null
                                : _loadInstagramConfig,
                            icon: const Icon(Icons.download_outlined, size: 18),
                            label: const Text('불러오기'),
                          ),
                        ],
                      ),
                      if (_instagramStatus != null) ...[
                        const SizedBox(height: 8),
                        Text(
                          () {
                            final status =
                                _instagramStatus ?? const <String, dynamic>{};
                            if (status['connected'] == true) {
                              final profile = (status['profile'] as Map?)
                                      ?.cast<String, dynamic>() ??
                                  const <String, dynamic>{};
                              final username =
                                  (profile['username'] ?? '').toString().trim();
                              final followers = int.tryParse(
                                      (profile['followersCount'] ?? 0)
                                          .toString()) ??
                                  0;
                              return username.isNotEmpty
                                  ? '연결 계정: @$username · 팔로워 $followers'
                                  : '연결 확인됨';
                            }
                            final reason =
                                (status['error'] ?? status['reason'] ?? '')
                                    .toString()
                                    .trim();
                            return reason.isNotEmpty
                                ? '연결 상태: $reason'
                                : '연결 상태: 미확인';
                          }(),
                          style: TextStyle(
                            fontSize: 12,
                            color: Theme.of(context)
                                .colorScheme
                                .onSurface
                                .withValues(alpha: 0.72),
                          ),
                        ),
                      ],
                      const SizedBox(height: 10),
                      const Text(
                        '연결 전 체크리스트',
                        style: TextStyle(fontWeight: FontWeight.w800),
                      ),
                      const SizedBox(height: 6),
                      _buildConnectionChecklistItem(
                        done: _igUserIdCtrl.text.trim().isNotEmpty,
                        title: 'Instagram User ID 저장',
                        hint: '프로필 조회와 연결 상태 확인에 사용됩니다.',
                      ),
                      _buildConnectionChecklistItem(
                        done: _igAccessTokenCtrl.text.trim().isNotEmpty,
                        title: 'Access Token 저장',
                        hint: 'Graph 응답 확인과 차후 업로드 자동화 전제조건입니다.',
                      ),
                      _buildConnectionChecklistItem(
                        done: _hasInstagramPageConfigOrConnection(),
                        title: 'Facebook Page 확보 또는 관리자 초대 수락',
                        hint: '새 페이지 생성이 막히면 기존 페이지 관리자 초대를 받아도 됩니다.',
                      ),
                      _buildConnectionChecklistItem(
                        done: _instagramStatus?['connected'] == true,
                        title: '연결 확인 1회 통과',
                        hint: '설정 저장 후 연결 확인으로 계정 응답 여부를 먼저 점검하세요.',
                      ),
                      const SizedBox(height: 10),
                      const Text(
                        '페이지 생성이 막히면',
                        style: TextStyle(fontWeight: FontWeight.w800),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        '브라우저에서 직접 페이지를 만들거나, 기존 페이지 관리자 초대를 받아 '
                        'Page ID만 연결해도 다음 단계 준비가 됩니다. 계정 상태/본인 확인 이슈가 있으면 '
                        '먼저 해소한 뒤 다시 연결하세요.',
                        style: TextStyle(
                          fontSize: 12,
                          color: Theme.of(context)
                              .colorScheme
                              .onSurface
                              .withValues(alpha: 0.72),
                        ),
                      ),
                      const SizedBox(height: 8),
                      Wrap(
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          OutlinedButton.icon(
                            onPressed: (_loading || _marketingBusy)
                                ? null
                                : () => _openExternalUrl(
                                      'https://www.facebook.com/pages/create',
                                    ),
                            icon: const Icon(Icons.open_in_browser_outlined,
                                size: 18),
                            label: const Text('브라우저 생성'),
                          ),
                          OutlinedButton.icon(
                            onPressed: (_loading || _marketingBusy)
                                ? null
                                : () => _openExternalUrl(
                                      'https://www.facebook.com/help/187316341316631',
                                    ),
                            icon:
                                const Icon(Icons.group_add_outlined, size: 18),
                            label: const Text('관리자 초대'),
                          ),
                          OutlinedButton.icon(
                            onPressed: (_loading || _marketingBusy)
                                ? null
                                : () => _openExternalUrl(
                                      'https://www.facebook.com/help/1392616391875085',
                                    ),
                            icon: const Icon(Icons.health_and_safety_outlined,
                                size: 18),
                            label: const Text('계정 상태'),
                          ),
                        ],
                      ),
                      const SizedBox(height: 6),
                      Text(
                        '페이지가 없어도 지금은 링크 생성, 클릭 집계, 릴스팩 생성, 수동 업로드 보조까지는 진행할 수 있습니다.',
                        style: TextStyle(
                          fontSize: 12,
                          color: Theme.of(context).colorScheme.primary,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 10),
                Row(
                  children: [
                    Expanded(
                      child: TextFormField(
                        initialValue: _marketingCampaign,
                        onChanged: (v) => _marketingCampaign = v.trim(),
                        decoration: const InputDecoration(
                          labelText: '캠페인 코드',
                          isDense: true,
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    SizedBox(
                      width: 140,
                      child: DropdownButtonFormField<String>(
                        initialValue: _marketingTone,
                        isExpanded: true,
                        decoration: const InputDecoration(
                          labelText: '톤',
                          isDense: true,
                        ),
                        items: const [
                          DropdownMenuItem(value: '실용적', child: Text('실용적')),
                          DropdownMenuItem(value: '감성적', child: Text('감성적')),
                          DropdownMenuItem(value: '비교형', child: Text('비교형')),
                        ],
                        onChanged: _marketingBusy
                            ? null
                            : (v) {
                                if (v == null) return;
                                setState(() => _marketingTone = v);
                              },
                      ),
                    ),
                    const SizedBox(width: 8),
                    TextButton.icon(
                      onPressed: (_marketingBusy || _loading)
                          ? null
                          : () => _loadMarketingLinks(silent: false),
                      icon: const Icon(Icons.sync, size: 18),
                      label: const Text('링크 새로고침'),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                Text(
                  '카드별 링크생성 후 인스타/블로그에 붙여 넣으세요. 선택 릴스팩은 Sora 영상 프롬프트까지 자동 생성됩니다.',
                  style: TextStyle(
                    fontSize: 12,
                    color: Theme.of(context)
                        .colorScheme
                        .onSurface
                        .withValues(alpha: 0.65),
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  '빠른 실효안: Meta 업로드 자동화 대신, 릴스팩 생성 후 수동 업로드 보조 문안과 추적 링크로 먼저 실주문 유입을 검증하세요.',
                  style: TextStyle(
                    fontSize: 12,
                    color: Theme.of(context)
                        .colorScheme
                        .onSurface
                        .withValues(alpha: 0.65),
                  ),
                ),
                if (_lastReelsPackResponse != null) ...[
                  const SizedBox(height: 4),
                  Align(
                    alignment: Alignment.centerLeft,
                    child: TextButton.icon(
                      onPressed: _marketingBusy
                          ? null
                          : () => _showManualUploadAssistDialog(
                                _lastReelsPackResponse!,
                              ),
                      icon: const Icon(Icons.upload_file_outlined, size: 18),
                      label: const Text('최근 수동 업로드 보조 다시보기'),
                    ),
                  ),
                ],
                if (_instagramFormat != null) ...[
                  const SizedBox(height: 6),
                  Text(
                    '권장 포맷: ${(_instagramFormat?['ratio'] ?? '9:16')} · '
                    '${(_instagramFormat?['resolution'] ?? '1080x1920')} · '
                    '${((_instagramFormat?['durationSec'] as Map?)?['recommended'] ?? 20)}초',
                    style: TextStyle(
                      fontSize: 12,
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: 0.62),
                    ),
                  ),
                ],
                if (_marketingBusy) ...[
                  const SizedBox(height: 8),
                  LinearProgressIndicator(
                    color: Theme.of(context).colorScheme.primary,
                  ),
                ],
              ],
            ),
          ),
          const SizedBox(height: 10),
          if (selectedCount > 0) ...[
            AppCard(
              child: Row(
                children: [
                  Expanded(child: Text('선택한 $selectedCount개')),
                  FilledButton.tonalIcon(
                    onPressed: uploadRunning
                        ? _requestStopUpload
                        : (_loading ? null : _uploadSelected),
                    icon: Icon(
                      uploadRunning
                          ? Icons.stop_circle_outlined
                          : Icons.cloud_upload_outlined,
                      size: 18,
                    ),
                    label: Text(uploadRunning ? '중단' : '선택 업로드'),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 10),
          ],
          if (_uploadProgress != null) ...[
            AppCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Icon(
                        uploadRunning
                            ? Icons.sync
                            : (uploadDone
                                ? Icons.cloud_done_outlined
                                : Icons.cloud_upload_outlined),
                        size: 18,
                        color: uploadDone
                            ? Theme.of(context).colorScheme.primary
                            : Theme.of(context).colorScheme.tertiary,
                      ),
                      const SizedBox(width: 8),
                      Expanded(
                        child: Text(
                          uploadRunning ? '다중 업로드 진행 중' : '다중 업로드 상태',
                          style: const TextStyle(fontWeight: FontWeight.w800),
                        ),
                      ),
                      if ((_activeUploadJobId ?? '').isNotEmpty)
                        Text(
                          '${uploadPercent != null ? '${uploadPercent.round()}% · ' : ''}#${_activeUploadJobId!.length > 8 ? _activeUploadJobId!.substring(0, 8) : _activeUploadJobId!}',
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
                    _uploadProgressMessage(_uploadProgress!),
                    style: TextStyle(
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: 0.85),
                    ),
                  ),
                  if (_uploadElapsedLabel().isNotEmpty) ...[
                    const SizedBox(height: 4),
                    Text(
                      '경과 시간: ${_uploadElapsedLabel()}',
                      style: TextStyle(
                        fontSize: 12,
                        color: Theme.of(context)
                            .colorScheme
                            .onSurface
                            .withValues(alpha: 0.6),
                      ),
                    ),
                  ],
                  if (_uploadProgressRatio(_uploadProgress!) != null) ...[
                    const SizedBox(height: 10),
                    LinearProgressIndicator(
                        value: _uploadProgressRatio(_uploadProgress!)),
                  ],
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
                          '${fillPercent != null ? '${fillPercent.round()}% · ' : ''}#${_activeFillJobId!.length > 8 ? _activeFillJobId!.substring(0, 8) : _activeFillJobId!}',
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
                        final reasonRaw = (row['errorDetail'] ??
                                row['skipReason'] ??
                                row['error'] ??
                                '')
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
                        ? '저장함 $visibleSavedCount개'
                        : '추천 $visibleRecoCount개'),
                color: Theme.of(context).colorScheme.primary,
              ),
              const SizedBox(width: 8),
              FilterChip(
                label: Text('저장함 $visibleSavedCount'),
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
                    ? '저장한 업로드 가능 후보만 표시 중'
                    : 'QC 검토 $hiddenRecoCount개 숨김 · 채우기 시 기존 추천 목록은 교체됩니다',
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
                    ? '저장한 업로드 가능 후보가 아직 없어요.'
                    : '업로드 가능한 추천이 없어요. 우측 상단 새로고침으로 다시 채우세요. (QC 검토 항목은 자동 숨김)',
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
                final seoScore =
                    num.tryParse((it['seoScore'] ?? '').toString())?.toInt();
                final seoGrade = (it['seoGrade'] ?? '').toString().trim();
                final seoGradeUpper = seoGrade.toUpperCase();
                final searchTags = _searchTagsOf(it, max: 8);
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
                final marketingLink =
                    _marketingLinkBySourceUrl[url] ?? const <String, dynamic>{};
                final marketingSlug =
                    (marketingLink['slug'] ?? '').toString().trim();
                final marketingTrackingUrl =
                    (marketingLink['trackingUrl'] ?? '').toString().trim();
                final marketingClickCount = marketingSlug.isNotEmpty
                    ? (_marketingClickCountBySlug[marketingSlug] ?? 0)
                    : 0;

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
                                if (seoScore != null)
                                  InfoChip(
                                    label: seoGradeUpper.isNotEmpty
                                        ? 'SEO $seoGradeUpper · $seoScore점'
                                        : 'SEO $seoScore점',
                                    color: seoGradeUpper == 'A'
                                        ? const Color(0xFF2F9E44)
                                        : (seoGradeUpper == 'B'
                                            ? const Color(0xFF1971C2)
                                            : (seoGradeUpper == 'C'
                                                ? Colors.orange
                                                : Colors.redAccent)),
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
                                if (marketingSlug.isNotEmpty)
                                  InfoChip(
                                    label: '유입 $marketingClickCount',
                                    color:
                                        Theme.of(context).colorScheme.secondary,
                                  ),
                              ],
                            ),
                            if (searchTags.isNotEmpty) ...[
                              const SizedBox(height: 6),
                              Wrap(
                                spacing: 6,
                                runSpacing: 6,
                                children: [
                                  for (final tag in searchTags.take(5))
                                    InfoChip(
                                      label: '#$tag',
                                      color: Theme.of(context)
                                          .colorScheme
                                          .tertiary,
                                    ),
                                  if (searchTags.length > 5)
                                    InfoChip(
                                      label: '+${searchTags.length - 5}',
                                      color:
                                          Theme.of(context).colorScheme.outline,
                                    ),
                                ],
                              ),
                            ],
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
                                const SizedBox(width: 4),
                                TextButton.icon(
                                  onPressed: (url.isEmpty || _marketingBusy)
                                      ? null
                                      : () => _createMarketingLinkForItem(it),
                                  icon: const Icon(Icons.campaign_outlined,
                                      size: 18),
                                  label: Text(marketingSlug.isNotEmpty
                                      ? '링크갱신'
                                      : '링크생성'),
                                ),
                                if (marketingSlug.isNotEmpty) ...[
                                  const SizedBox(width: 4),
                                  TextButton.icon(
                                    onPressed: _marketingBusy
                                        ? null
                                        : () async {
                                            final messenger =
                                                ScaffoldMessenger.of(context);
                                            final text =
                                                marketingTrackingUrl.isNotEmpty
                                                    ? marketingTrackingUrl
                                                    : '/go/m/$marketingSlug';
                                            await Clipboard.setData(
                                                ClipboardData(text: text));
                                            if (!mounted) return;
                                            messenger.showSnackBar(
                                              const SnackBar(
                                                  content:
                                                      Text('마케팅 링크를 복사했어요.')),
                                            );
                                          },
                                    icon: const Icon(Icons.link, size: 18),
                                    label: const Text('링크복사'),
                                  ),
                                  const SizedBox(width: 4),
                                  TextButton.icon(
                                    onPressed: _marketingBusy
                                        ? null
                                        : () =>
                                            _refreshMarketingClicksForItem(it),
                                    icon: const Icon(Icons.bar_chart, size: 18),
                                    label: Text('클릭 $marketingClickCount'),
                                  ),
                                ],
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
