import 'package:couplus_mobile/ui/widgets.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

class PreviewDetailScreen extends StatelessWidget {
  const PreviewDetailScreen({
    super.key,
    required this.url,
    required this.preview,
  });

  final String url;
  final Map<String, dynamic> preview;

  static bool _isBlank(Object? v) {
    if (v == null) return true;
    final s = v.toString().trim();
    return s.isEmpty || s == 'null' || s == '-' || s == '0';
  }

  static String _s(Object? v, {String fallback = ''}) {
    if (v == null) return fallback;
    final s = v.toString().trim();
    return s.isEmpty ? fallback : s;
  }

  static bool _looksLikePurchaseOption(Map<String, dynamic> o) {
    final name = _s(o['name'] ?? o['optionName']);
    final lowered = name.replaceAll(' ', '');

    // 상세정보/고시/안내 같은 항목은 구매옵션에서 제외
    const denyKeywords = [
      '상세정보',
      '고시',
      '상품정보',
      '구매안내',
      '배송안내',
      '교환',
      '반품',
      '주의사항',
      '안내',
    ];
    for (final kw in denyKeywords) {
      if (lowered.contains(kw)) return false;
    }

    final price =
        o['price'] ?? o['salePrice'] ?? o['finalPrice'] ?? o['optionPrice'];
    final stock = o['stock'] ?? o['inventory'] ?? o['qty'] ?? o['quantity'];

    if (!_isBlank(price)) return true;
    if (!_isBlank(stock)) return true;

    // 스키마 힌트
    if (o.containsKey('optionName') || o.containsKey('optionValue')) {
      return true;
    }
    if (o.containsKey('values') || o.containsKey('items')) return true;

    return false;
  }

  static bool _looksLikeInfoSpec(Map<String, dynamic> o) {
    final name = _s(o['name'] ?? o['title'] ?? o['key'] ?? o['label']);
    final lowered = name.replaceAll(' ', '');

    const infoKeywords = [
      '상세정보',
      '고시',
      '상품정보',
      '주의사항',
      '안내',
      '정보',
      '원산지',
      '제조',
      '브랜드',
      '모델',
    ];
    for (final kw in infoKeywords) {
      if (lowered.contains(kw)) return true;
    }

    if (o.containsKey('spec') ||
        o.containsKey('notice') ||
        o.containsKey('detail')) {
      return true;
    }

    // 구매옵션으로 확실히 보이지 않으면 정보/고시로 취급
    return !_looksLikePurchaseOption(o);
  }

  static String _summarizeKeys(Object? v, {int depth = 2}) {
    if (depth <= 0) return '';
    if (v is Map) {
      final keys = v.keys.map((e) => e.toString()).toList()..sort();
      final buf = StringBuffer();
      buf.writeln('키(${keys.length}): ${keys.join(', ')}');
      // 1레벨 더
      for (final k in keys.take(20)) {
        final child = v[k];
        if (child is Map) {
          final childKeys = child.keys.map((e) => e.toString()).toList()
            ..sort();
          buf.writeln('  - $k → {${childKeys.take(30).join(', ')}}');
        } else if (child is List) {
          buf.writeln('  - $k → 리스트(${child.length})');
          if (child.isNotEmpty && child.first is Map) {
            final first = (child.first as Map);
            final childKeys = first.keys.map((e) => e.toString()).toList()
              ..sort();
            buf.writeln('      예시 아이템 키: {${childKeys.take(40).join(', ')}}');
          }
        }
      }
      return buf.toString().trimRight();
    }
    if (v is List) {
      return '리스트(${v.length})';
    }
    return v.runtimeType.toString();
  }

  Widget _metaRows(BuildContext context, Map<String, dynamic> draft,
      Map<String, dynamic> computed, List options) {
    final rows = <Widget>[];

    void add(String k, Object? v, {bool copyable = false}) {
      if (_isBlank(v)) return;
      final value = v.toString();
      rows.add(copyable
          ? CopyableSingleLineRow(k: k, value: value)
          : KvRow(k: k, v: value));
    }

    add('원본 URL', url, copyable: true);
    add('최종가', computed['finalPrice']);
    add('옵션 개수', options.length);

    // draft/computed에서 자주 나오는 메타 필드들(있으면 표시)
    add('브랜드', draft['brand'] ?? computed['brand']);
    add('판매자',
        draft['sellerName'] ?? computed['sellerName'] ?? draft['seller']);
    add('배송비', computed['shippingFee'] ?? draft['shippingFee']);
    add('카테고리', draft['categoryName'] ?? computed['categoryName']);

    return Column(children: rows);
  }

  Widget _optionList(BuildContext context, List<Map<String, dynamic>> list,
      {required bool purchaseStyle}) {
    final cs = Theme.of(context).colorScheme;

    if (list.isEmpty) {
      return Text(
        purchaseStyle ? '구매 옵션이 없습니다.' : '상세정보/고시 항목이 없습니다.',
        style: TextStyle(color: cs.onSurface.withValues(alpha: 0.65)),
      );
    }

    final shown = list.take(60).toList();

    return Column(
      children: [
        ...shown.map((o) {
          final name =
              _s(o['name'] ?? o['optionName'] ?? o['title'], fallback: '(항목)');
          final value = _s(o['value'] ?? o['optionValue'] ?? o['content']);
          final price = _s(o['price'] ?? o['salePrice'] ?? o['finalPrice']);
          final stock =
              _s(o['stock'] ?? o['inventory'] ?? o['qty'] ?? o['quantity']);

          final subtitle = purchaseStyle
              ? '가격: ${price.isEmpty ? '-' : price} · 재고: ${stock.isEmpty ? '-' : stock}'
              : (value.isEmpty ? '' : value);

          return Padding(
            padding: const EdgeInsets.symmetric(vertical: 6),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(name, style: const TextStyle(fontWeight: FontWeight.w800)),
                if (subtitle.isNotEmpty) ...[
                  const SizedBox(height: 4),
                  Text(
                    subtitle,
                    style: TextStyle(
                      fontSize: 12,
                      color: cs.onSurface.withValues(alpha: 0.65),
                    ),
                  ),
                ],
              ],
            ),
          );
        }),
        if (list.length > 60) ...[
          const Divider(height: 24),
          Text(
            '항목이 많아서 일부만 표시했어요. (${list.length}개 중 60개 표시)',
            style: TextStyle(
              fontSize: 12,
              color: cs.onSurface.withValues(alpha: 0.65),
            ),
          ),
        ]
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final draft = (preview['draft'] as Map?)?.cast<String, dynamic>() ?? {};
    final computed =
        (preview['computed'] as Map?)?.cast<String, dynamic>() ?? {};
    final optionsRaw = (preview['options'] as List?) ?? const [];

    final title = _s(draft['title'], fallback: '(제목 없음)');
    final imageUrl = _s(draft['imageUrl']);

    final optionMaps = optionsRaw
        .map((e) => (e as Map?)?.cast<String, dynamic>() ?? <String, dynamic>{})
        .where((e) => e.isNotEmpty)
        .toList();

    final purchaseOptions = <Map<String, dynamic>>[];
    final infoSpecs = <Map<String, dynamic>>[];

    for (final o in optionMaps) {
      if (_looksLikePurchaseOption(o)) {
        purchaseOptions.add(o);
      } else if (_looksLikeInfoSpec(o)) {
        infoSpecs.add(o);
      } else {
        // fallback
        infoSpecs.add(o);
      }
    }

    return AppScaffold(
      title: '미리보기 상세',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeader('상품'),
                const SizedBox(height: 10),
                if (imageUrl.isNotEmpty)
                  ClipRRect(
                    borderRadius: BorderRadius.circular(14),
                    child: AspectRatio(
                      aspectRatio: 16 / 9,
                      child: Image.network(
                        imageUrl,
                        fit: BoxFit.cover,
                        errorBuilder: (_, __, ___) => Container(
                          color: Theme.of(context)
                              .colorScheme
                              .surfaceContainerHighest,
                          child: const Center(
                              child: Icon(Icons.image_not_supported)),
                        ),
                      ),
                    ),
                  )
                else
                  Container(
                    height: 140,
                    decoration: BoxDecoration(
                      color:
                          Theme.of(context).colorScheme.surfaceContainerHighest,
                      borderRadius: BorderRadius.circular(14),
                    ),
                    child: const Center(child: Icon(Icons.image)),
                  ),
                const SizedBox(height: 12),
                Text(
                  title,
                  style: Theme.of(context)
                      .textTheme
                      .titleLarge
                      ?.copyWith(fontWeight: FontWeight.w900),
                ),
                const SizedBox(height: 8),
                _metaRows(context, draft, computed, optionsRaw),
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SectionHeader(
                  '구매 옵션',
                  trailing: InfoChip(label: '${purchaseOptions.length}개'),
                ),
                const SizedBox(height: 10),
                _optionList(context, purchaseOptions, purchaseStyle: true),
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SectionHeader(
                  '상세정보/고시',
                  trailing: InfoChip(label: '${infoSpecs.length}개'),
                ),
                const SizedBox(height: 10),
                _optionList(context, infoSpecs, purchaseStyle: false),
              ],
            ),
          ),
          if (kDebugMode) ...[
            const SizedBox(height: 12),
            AppCard(
              child: ExpansionTile(
                tilePadding: EdgeInsets.zero,
                childrenPadding: EdgeInsets.zero,
                title: const Text(
                  '디버그(개발자용)',
                  style: TextStyle(fontWeight: FontWeight.w900),
                ),
                subtitle: const Text('알 수 없는 스키마를 분석하기 위한 키 요약입니다.'),
                children: [
                  const SizedBox(height: 8),
                  Text(
                    _summarizeKeys(preview),
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
          ]
        ],
      ),
    );
  }
}
