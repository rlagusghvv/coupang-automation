import 'package:couplus_mobile/api/api_client.dart';
import 'package:couplus_mobile/screens/my_products_screen.dart';
import 'package:couplus_mobile/screens/orders_screen.dart';
import 'package:couplus_mobile/ui/widgets.dart';
import 'package:flutter/material.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({
    super.key,
    required this.api,
    required this.onOpenTab,
  });

  final ApiClient api;
  final ValueChanged<int> onOpenTab;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  Map<String, dynamic>? _dashboard;
  List<Map<String, dynamic>> _orders = const [];
  List<Map<String, dynamic>> _products = const [];
  String? _error;
  bool _loading = false;

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

    final errors = <String>[];
    Map<String, dynamic>? dashboard;
    List<Map<String, dynamic>> orders = const [];
    List<Map<String, dynamic>> products = const [];

    try {
      final json = await widget.api.getJson('/api/dashboard');
      dashboard = json;
    } catch (e) {
      errors.add('대시보드: $e');
    }

    try {
      final json =
          await widget.api.getJson('/api/orders', query: {'limit': '200'});
      final list = (json['orders'] as List?) ?? const [];
      orders = list.map((e) => (e as Map).cast<String, dynamic>()).toList();
    } catch (e) {
      errors.add('주문: $e');
    }

    try {
      final json =
          await widget.api.getJson('/api/catalog', query: {'limit': '200'});
      final list = (json['products'] as List?) ?? const [];
      products = list.map((e) => (e as Map).cast<String, dynamic>()).toList();
    } catch (e) {
      errors.add('상품: $e');
    }

    if (!mounted) return;
    setState(() {
      _dashboard = dashboard;
      _orders = orders;
      _products = products;
      _error = errors.isEmpty ? null : errors.join('\n');
      _loading = false;
    });
  }

  int _orderCount(String status) {
    return _orders
        .where((o) =>
            (o['status'] ?? '').toString().trim().toUpperCase() == status)
        .length;
  }

  int _productCount(String status) {
    return _products
        .where((p) =>
            (p['status'] ?? '').toString().trim().toLowerCase() == status)
        .length;
  }

  bool _isLowPriceFlagged(Map<String, dynamic> product) {
    final raw = product['priceAudit'];
    if (raw is! Map) return false;
    return raw['flagged'] == true;
  }

  Future<void> _openProductQueue({
    required String title,
    String initialStatus = '',
    bool recoveryOnly = false,
    bool lowPriceOnly = false,
  }) async {
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => MyProductsScreen(
          api: widget.api,
          titleOverride: title,
          initialStatus: initialStatus,
          initialRecoveryOnly: recoveryOnly,
          initialLowPriceOnly: lowPriceOnly,
        ),
      ),
    );
    if (mounted) {
      await _refresh();
    }
  }

  Future<void> _openOrdersQueue({
    required String title,
    required List<String> statuses,
    bool onlyTodo = false,
    bool toolsExpanded = false,
    String? queueLabel,
  }) async {
    await Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => OrdersScreen(
          api: widget.api,
          titleOverride: title,
          initialStatuses: statuses,
          initialOnlyTodo: onlyTodo,
          initialToolsExpanded: toolsExpanded,
          queueLabel: queueLabel ?? title,
        ),
      ),
    );
    if (mounted) {
      await _refresh();
    }
  }

  @override
  Widget build(BuildContext context) {
    final data = _dashboard;
    final auth = (data?['auth'] as Map?) ?? {};
    final sessionStatus = (data?['sessionStatus'] as Map?) ?? {};
    final domeme = (sessionStatus['domeme'] as Map?) ?? {};
    final domeggook = (sessionStatus['domeggook'] as Map?) ?? {};
    final purchaseLogs = (data?['purchaseLogs'] as List?) ?? const [];
    final payUrls = (data?['payUrls'] as Map?) ?? {};

    final isAuthed = auth['authenticated'] == true;
    final acceptOrders = _orderCount('ACCEPT');
    final instructOrders = _orderCount('INSTRUCT');
    final readyOrders = _orderCount('READY');
    final deliveringOrders = _orderCount('DELIVERING');
    final pendingApproval = _productCount('pending_approval');
    final reviewNeeded =
        _productCount('deployed_invalid') + _productCount('deploy_failed');
    final lowPriceCount = _products.where(_isLowPriceFlagged).length;
    final draftSaved = _productCount('draft_saved');
    final blockerItems = <_SimpleBlockerItem>[
      if (!isAuthed)
        const _SimpleBlockerItem(
          label: '로그인 필요',
          hint: '더보기에서 다시 로그인해야 주문/상품 작업이 동작합니다.',
        ),
      if (domeme['valid'] != true)
        const _SimpleBlockerItem(
          label: '도매매 세션 미연결',
          hint: '주문 업로드와 결제 링크 추출 전에 연결이 필요합니다.',
        ),
      if (domeggook['valid'] != true)
        const _SimpleBlockerItem(
          label: '도매꾹 세션 미연결',
          hint: '추천 수집과 공급처 재확인이 제한될 수 있습니다.',
        ),
    ];

    final queueItems = <_QueueItem>[
      if (!isAuthed)
        _QueueItem(
          priority: 0,
          label: '로그인이 끊겨 있습니다.',
          hint: '더보기에서 다시 로그인해야 주문/상품 작업이 동작합니다.',
          countLabel: '설정 필요',
          actionLabel: '설정',
          onTap: () => widget.onOpenTab(4),
        ),
      if (domeme['valid'] != true)
        _QueueItem(
          priority: 1,
          label: '도매매 세션이 없습니다.',
          hint: '주문 업로드와 결제 링크 추출 전에 세션을 먼저 연결해야 합니다.',
          countLabel: '연결 필요',
          actionLabel: '설정',
          onTap: () => widget.onOpenTab(4),
        ),
      if (acceptOrders > 0)
        _QueueItem(
          priority: 2,
          label: '발주확인 대기 주문',
          hint: '쿠팡 접수 상태 주문입니다. 먼저 발주확인을 끝내야 다음 단계로 넘어갑니다.',
          countLabel: '$acceptOrders건',
          actionLabel: '열기',
          onTap: () => _openOrdersQueue(
            title: '발주확인 대기',
            statuses: const ['ACCEPT'],
            queueLabel: '발주확인 대기',
          ),
        ),
      if (instructOrders > 0)
        _QueueItem(
          priority: 3,
          label: '결제 링크 대기 주문',
          hint: '공급처 주문과 결제 링크 확인이 필요한 주문입니다.',
          countLabel: '$instructOrders건',
          actionLabel: '공급처 주문',
          onTap: () => _openOrdersQueue(
            title: '결제 링크 대기',
            statuses: const ['INSTRUCT'],
            toolsExpanded: true,
            queueLabel: '결제 링크 대기',
          ),
        ),
      if (readyOrders > 0)
        _QueueItem(
          priority: 4,
          label: '송장 업로드 대기 주문',
          hint: '공급처 주문 이후 송장 입력이 필요한 주문입니다.',
          countLabel: '$readyOrders건',
          actionLabel: '송장 입력',
          onTap: () => _openOrdersQueue(
            title: '송장 업로드 대기',
            statuses: const ['READY'],
            queueLabel: '송장 업로드 대기',
          ),
        ),
      if (reviewNeeded > 0)
        _QueueItem(
          priority: 5,
          label: '검증 필요 상품',
          hint: '업로드 실패, 검증 필요, 임시저장 상품을 먼저 정리하세요.',
          countLabel: '$reviewNeeded건',
          actionLabel: '복구 열기',
          onTap: () => _openProductQueue(
            title: '복구 큐',
            recoveryOnly: true,
          ),
        ),
      if (lowPriceCount > 0)
        _QueueItem(
          priority: 6,
          label: '저가 의심 상품',
          hint: '공급가 대비 비정상적으로 낮은 상품입니다. 삭제나 재검토가 필요합니다.',
          countLabel: '$lowPriceCount건',
          actionLabel: '저가 점검',
          onTap: () => _openProductQueue(
            title: '저가 의심 상품',
            recoveryOnly: true,
            lowPriceOnly: true,
          ),
        ),
      if (pendingApproval > 0)
        _QueueItem(
          priority: 7,
          label: '승인대기 상품',
          hint: 'Wing에서 승인되기 전 상태입니다. 오래 머무르면 재확인이 필요합니다.',
          countLabel: '$pendingApproval건',
          actionLabel: '열기',
          onTap: () => _openProductQueue(
            title: '승인대기 상품',
            initialStatus: 'pending_approval',
          ),
        ),
      if (draftSaved > 0)
        _QueueItem(
          priority: 8,
          label: '임시저장 상품',
          hint: '승인 전 초안 상태입니다. 재업로드나 정리가 필요할 수 있습니다.',
          countLabel: '$draftSaved건',
          actionLabel: '열기',
          onTap: () => _openProductQueue(
            title: '임시저장 상품',
            initialStatus: 'draft_saved',
          ),
        ),
      if (domeggook['valid'] != true)
        _QueueItem(
          priority: 9,
          label: '도매꾹 세션이 없습니다.',
          hint: '추천 수집이나 공급처 재확인 작업이 제한될 수 있습니다.',
          countLabel: '연결 필요',
          actionLabel: '설정',
          onTap: () => widget.onOpenTab(4),
        ),
    ]..sort((a, b) => a.priority.compareTo(b.priority));

    final recentLogs = purchaseLogs
        .take(4)
        .map((e) =>
            (e as Map?)?.cast<String, dynamic>() ?? const <String, dynamic>{})
        .toList();

    return AppScaffold(
      title: '운영',
      onRefresh: _refresh,
      actions: [
        IconButton(
          onPressed: _loading ? null : _refresh,
          icon: const Icon(Icons.refresh),
        ),
      ],
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              InfoChip(
                label:
                    queueItems.isEmpty ? '운영 가능' : '할 일 ${queueItems.length}',
                color: queueItems.isEmpty
                    ? const Color(0xFF2F9E44)
                    : const Color(0xFFE67700),
              ),
              const SizedBox(width: 8),
              if (_loading)
                const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
            ],
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            ErrorBanner(message: _error!, onRetry: _refresh),
          ],
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeader('우선 처리 큐'),
                const SizedBox(height: 12),
                Text(
                  '위에서부터 처리하면 됩니다. 주문과 상품 예외를 한 화면에서 우선순위대로 모았습니다.',
                  style: TextStyle(
                    color: Theme.of(context)
                        .colorScheme
                        .onSurface
                        .withValues(alpha: 0.68),
                  ),
                ),
                const SizedBox(height: 12),
                if (queueItems.isEmpty)
                  Text(
                    '지금은 긴급하게 처리할 항목이 없습니다. 새 업로드나 완료 기록만 확인하면 됩니다.',
                    style: TextStyle(
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: 0.68),
                    ),
                  )
                else
                  ...queueItems.take(8).toList().asMap().entries.map(
                        (entry) => Padding(
                          padding: const EdgeInsets.only(bottom: 10),
                          child: _QueueRow(
                            index: entry.key,
                            item: entry.value,
                          ),
                        ),
                      ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeader('바로 가기'),
                const SizedBox(height: 12),
                Wrap(
                  spacing: 10,
                  runSpacing: 10,
                  children: [
                    FilledButton.tonalIcon(
                      onPressed: () => _openOrdersQueue(
                        title: '해야 할 주문',
                        statuses: const ['ACCEPT', 'INSTRUCT', 'READY'],
                        queueLabel: '해야 할 주문',
                      ),
                      icon: const Icon(Icons.receipt_long_outlined),
                      label: const Text('주문 처리'),
                    ),
                    FilledButton.tonalIcon(
                      onPressed: () => _openProductQueue(
                        title: '복구 큐',
                        recoveryOnly: true,
                      ),
                      icon: const Icon(Icons.inventory_2_outlined),
                      label: const Text('예외 상품 정리'),
                    ),
                    FilledButton.tonalIcon(
                      onPressed: () => widget.onOpenTab(1),
                      icon: const Icon(Icons.work_outline),
                      label: const Text('업로드'),
                    ),
                    FilledButton.tonalIcon(
                      onPressed: () => widget.onOpenTab(4),
                      icon: const Icon(Icons.settings_outlined),
                      label: const Text('세션 / 설정'),
                    ),
                  ],
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeader('오늘 완료한 일'),
                const SizedBox(height: 10),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    InfoChip(
                      label: '배송중 $deliveringOrders',
                      color: const Color(0xFF1971C2),
                    ),
                    InfoChip(
                      label: '결제 링크 ${payUrls.keys.length}',
                      color: const Color(0xFF5F3DC4),
                    ),
                    InfoChip(
                      label: '최근 처리 ${purchaseLogs.length}',
                      color: const Color(0xFF2F9E44),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                if (recentLogs.isEmpty)
                  Text(
                    '아직 오늘 완료 기록이 많지 않습니다. 주문 처리나 업로드를 진행하면 여기에 최근 완료 내역이 쌓입니다.',
                    style: TextStyle(
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: 0.68),
                    ),
                  )
                else
                  ...recentLogs.map((row) {
                    final summary = (row['summary'] ??
                            row['message'] ??
                            row['type'] ??
                            '기록')
                        .toString()
                        .trim();
                    final createdAt =
                        (row['createdAt'] ?? row['created_at'] ?? '')
                            .toString()
                            .trim();
                    return Padding(
                      padding: const EdgeInsets.symmetric(vertical: 6),
                      child: Row(
                        children: [
                          const Icon(
                            Icons.check_circle_outline,
                            size: 16,
                            color: Color(0xFF2F9E44),
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              summary.isEmpty ? '처리 기록' : summary,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                          if (createdAt.isNotEmpty) ...[
                            const SizedBox(width: 10),
                            Text(
                              createdAt,
                              style: TextStyle(
                                fontSize: 12,
                                color: Theme.of(context)
                                    .colorScheme
                                    .onSurface
                                    .withValues(alpha: 0.58),
                              ),
                            ),
                          ],
                        ],
                      ),
                    );
                  }),
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeader('아직 막힌 일'),
                const SizedBox(height: 10),
                if (blockerItems.isEmpty)
                  Text(
                    '지금 자동화를 막는 큰 연결 문제는 없습니다.',
                    style: TextStyle(
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: 0.68),
                    ),
                  )
                else
                  ...blockerItems.map(
                    (item) => Padding(
                      padding: const EdgeInsets.only(bottom: 10),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Padding(
                            padding: EdgeInsets.only(top: 2),
                            child: Icon(
                              Icons.link_off_rounded,
                              size: 18,
                              color: Color(0xFFE67700),
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  item.label,
                                  style: const TextStyle(
                                    fontWeight: FontWeight.w800,
                                  ),
                                ),
                                const SizedBox(height: 4),
                                Text(
                                  item.hint,
                                  style: TextStyle(
                                    color: Theme.of(context)
                                        .colorScheme
                                        .onSurface
                                        .withValues(alpha: 0.68),
                                  ),
                                ),
                              ],
                            ),
                          ),
                          const SizedBox(width: 8),
                          TextButton(
                            onPressed: () => widget.onOpenTab(4),
                            child: const Text('설정'),
                          ),
                        ],
                      ),
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

class _QueueRow extends StatelessWidget {
  const _QueueRow({
    required this.index,
    required this.item,
  });

  final int index;
  final _QueueItem item;

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Container(
          width: 28,
          height: 28,
          alignment: Alignment.center,
          decoration: BoxDecoration(
            color:
                Theme.of(context).colorScheme.primary.withValues(alpha: 0.08),
            borderRadius: BorderRadius.circular(999),
          ),
          child: Text(
            '${index + 1}',
            style: const TextStyle(fontWeight: FontWeight.w900),
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(item.label,
                  style: const TextStyle(fontWeight: FontWeight.w800)),
              const SizedBox(height: 4),
              InfoChip(label: item.countLabel, color: const Color(0xFFE9ECEF)),
              const SizedBox(height: 4),
              Text(
                item.hint,
                style: TextStyle(
                  color: Theme.of(context)
                      .colorScheme
                      .onSurface
                      .withValues(alpha: 0.68),
                ),
              ),
            ],
          ),
        ),
        const SizedBox(width: 8),
        TextButton(
          onPressed: item.onTap,
          child: Text(item.actionLabel),
        ),
      ],
    );
  }
}

class _QueueItem {
  const _QueueItem({
    required this.priority,
    required this.label,
    required this.hint,
    required this.countLabel,
    required this.actionLabel,
    required this.onTap,
  });

  final int priority;
  final String label;
  final String hint;
  final String countLabel;
  final String actionLabel;
  final VoidCallback onTap;
}

class _SimpleBlockerItem {
  const _SimpleBlockerItem({
    required this.label,
    required this.hint,
  });

  final String label;
  final String hint;
}
