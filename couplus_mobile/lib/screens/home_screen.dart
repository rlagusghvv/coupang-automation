import 'package:couplus_mobile/api/api_client.dart';
import 'package:couplus_mobile/ui/widgets.dart';
import 'package:flutter/material.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.api});

  final ApiClient api;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  Map<String, dynamic>? _data;
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
    try {
      final json = await widget.api.getJson('/api/dashboard');
      setState(() => _data = json);
    } catch (e) {
      setState(() => _error = e.toString());
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final data = _data;
    final auth = (data?['auth'] as Map?) ?? {};
    final sessionStatus = (data?['sessionStatus'] as Map?) ?? {};

    final domeme = (sessionStatus['domeme'] as Map?) ?? {};
    final domeggook = (sessionStatus['domeggook'] as Map?) ?? {};

    final previewHistory = (data?['previewHistory'] as List?) ?? const [];
    final purchaseLogs = (data?['purchaseLogs'] as List?) ?? const [];
    final payUrls = (data?['payUrls'] as Map?) ?? {};

    final isAuthed = auth['authenticated'] == true;

    return AppScaffold(
      title: '쿠팡코끼리',
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
                label: isAuthed ? '로그인됨' : '로그인 필요',
                color: isAuthed
                    ? const Color(0xFF2F9E44)
                    : const Color(0xFFE03131),
              ),
              const SizedBox(width: 10),
              if (_loading)
                const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2)),
            ],
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            ErrorBanner(message: _error!, onRetry: _refresh),
          ],
          const SizedBox(height: 14),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeader('세션 상태'),
                const SizedBox(height: 10),
                KvRow(
                  k: '도매매',
                  v: domeme['valid'] == true ? '연결됨' : '미연결',
                  vStyle: TextStyle(
                    fontWeight: FontWeight.w800,
                    color: domeme['valid'] == true
                        ? const Color(0xFF2F9E44)
                        : Theme.of(context)
                            .colorScheme
                            .onSurface
                            .withValues(alpha: 0.65),
                  ),
                ),
                KvRow(
                  k: '도매꾹',
                  v: domeggook['valid'] == true ? '연결됨' : '미연결',
                  vStyle: TextStyle(
                    fontWeight: FontWeight.w800,
                    color: domeggook['valid'] == true
                        ? const Color(0xFF2F9E44)
                        : Theme.of(context)
                            .colorScheme
                            .onSurface
                            .withValues(alpha: 0.65),
                  ),
                ),
                const Divider(height: 24),
                Text(
                  '로그인/세션 관리는 More 탭에서 할 수 있어요.',
                  style: TextStyle(
                      color: Theme.of(context)
                          .colorScheme
                          .onSurface
                          .withValues(alpha: 0.65)),
                ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeader('최근 활동'),
                const SizedBox(height: 10),
                Row(
                  children: [
                    Expanded(
                        child: _Metric(
                            title: '미리보기', value: '${previewHistory.length}')),
                    const SizedBox(width: 10),
                    Expanded(
                        child: _Metric(
                            title: '구매 로그', value: '${purchaseLogs.length}')),
                    const SizedBox(width: 10),
                    Expanded(
                        child: _Metric(
                            title: '결제 링크', value: '${payUrls.keys.length}')),
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
                const SectionHeader('계정'),
                const SizedBox(height: 10),
                KvRow(k: '로그인', v: isAuthed ? '예' : '아니오'),
                if (isAuthed) ...[
                  KvRow(
                    k: 'Email',
                    v: ((auth['user'] as Map?)?['email'] ?? '-').toString(),
                  ),
                  KvRow(
                    k: 'User ID',
                    v: ((auth['user'] as Map?)?['id'] ?? '-').toString(),
                  ),
                ] else
                  Text(
                    'More 탭에서 로그인하면 작업 탭의 모든 기능을 사용할 수 있어요.',
                    style: TextStyle(
                        color: Theme.of(context)
                            .colorScheme
                            .onSurface
                            .withValues(alpha: 0.65)),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 12),
          AppCard(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const SectionHeader('Pay URLs'),
                const SizedBox(height: 10),
                if (!isAuthed)
                  Text(
                    '로그인 후 확인할 수 있어요.',
                    style: TextStyle(
                        color: Theme.of(context)
                            .colorScheme
                            .onSurface
                            .withValues(alpha: 0.65)),
                  )
                else if (payUrls.isEmpty)
                  Text(
                    '아직 결제 URL이 없어요.',
                    style: TextStyle(
                        color: Theme.of(context)
                            .colorScheme
                            .onSurface
                            .withValues(alpha: 0.65)),
                  )
                else
                  ...payUrls.entries.map((e) {
                    return KvRow(k: e.key.toString(), v: e.value.toString());
                  }),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Metric extends StatelessWidget {
  const _Metric({required this.title, required this.value});

  final String title;
  final String value;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: cs.primary.withValues(alpha: 0.06),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: TextStyle(
                fontSize: 12,
                fontWeight: FontWeight.w700,
                color: cs.onSurface.withValues(alpha: 0.65)),
          ),
          const SizedBox(height: 6),
          Text(value,
              style:
                  const TextStyle(fontSize: 18, fontWeight: FontWeight.w900)),
        ],
      ),
    );
  }
}
