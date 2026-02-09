import 'package:couplus_mobile/ui/widgets.dart';
import 'package:flutter/material.dart';

class OrderDetailScreen extends StatelessWidget {
  const OrderDetailScreen({super.key, required this.order});

  final Map<String, dynamic> order;

  @override
  Widget build(BuildContext context) {
    final status = (order['status'] ?? '').toString();
    final at = (order['at'] ?? '').toString();

    final raw = (order['order'] as Map?)?.cast<String, dynamic>() ?? {};
    final sheet = (raw['sheet'] as Map?)?.cast<String, dynamic>() ?? {};
    final item = (raw['item'] as Map?)?.cast<String, dynamic>() ?? {};

    final receiver = (sheet['receiver'] as Map?)?.cast<String, dynamic>() ?? {};

    final name = (receiver['name'] ?? '').toString();
    final postCode = (receiver['postCode'] ?? '').toString();
    final addr1 = (receiver['addr1'] ?? '').toString();
    final addr2 = (receiver['addr2'] ?? '').toString();
    final phone = (receiver['receiverNumber'] ?? receiver['safeNumber'] ?? '').toString();

    final title = (item['vendorItemName'] ?? item['sellerProductName'] ?? '').toString();
    final qty = (item['shippingCount'] ?? '').toString();

    return AppScaffold(
      title: '주문 상세',
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeader('주문 정보'),
                const SizedBox(height: 10),
                KvRow(k: '상태', v: status.isEmpty ? '-' : status),
                KvRow(k: '시간', v: at.isEmpty ? '-' : at),
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeader('상품'),
                const SizedBox(height: 10),
                Text(
                  title.isEmpty ? '(상품명 없음)' : title,
                  style: const TextStyle(fontWeight: FontWeight.w900),
                ),
                const SizedBox(height: 8),
                KvRow(k: '수량', v: qty.isEmpty ? '-' : qty),
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeader('받는 사람'),
                const SizedBox(height: 10),
                KvRow(k: '이름', v: name.isEmpty ? '-' : name),
                KvRow(k: '전화', v: phone.isEmpty ? '-' : phone),
                KvRow(k: '우편번호', v: postCode.isEmpty ? '-' : postCode),
                KvRow(k: '주소', v: addr1.isEmpty ? '-' : addr1),
                KvRow(k: '상세주소', v: addr2.isEmpty ? '-' : addr2),
                if (name.isEmpty && addr1.isEmpty)
                  Text(
                    '받는 사람 정보가 없어요.\n(쿠팡 데이터에 없거나, 아직 저장되지 않았을 수 있어요.)',
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.7),
                    ),
                  ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
