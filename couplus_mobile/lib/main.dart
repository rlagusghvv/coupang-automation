import 'package:couplus_mobile/api/api_client.dart';
import 'package:couplus_mobile/screens/home_screen.dart';
import 'package:couplus_mobile/screens/more_screen.dart';
import 'package:couplus_mobile/screens/work_screen.dart';
import 'package:couplus_mobile/screens/my_products_screen.dart';
import 'package:couplus_mobile/screens/orders_screen.dart';
import 'package:couplus_mobile/services/push_token_service.dart';
import 'package:couplus_mobile/ui/app_theme.dart';
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  runApp(const CouplusApp());
}

class CouplusApp extends StatelessWidget {
  const CouplusApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'CoupElephant',
      theme: AppTheme.light(),
      darkTheme: AppTheme.dark(),
      themeMode: ThemeMode.system,
      home: const RootTabs(),
    );
  }
}

class RootTabs extends StatefulWidget {
  const RootTabs({super.key});

  @override
  State<RootTabs> createState() => _RootTabsState();
}

class _RootTabsState extends State<RootTabs> {
  static const _kLastTabIndex = 'last_tab_index';
  int _index = 0;

  late final ApiClient _api = ApiClient();

  @override
  void initState() {
    super.initState();
    _api.init();
    _restoreLastTab();
    // Native APNs token -> server registration (best-effort)
    PushTokenService.instance.bind(_api);
  }

  Future<void> _restoreLastTab() async {
    try {
      final p = await SharedPreferences.getInstance();
      final saved = p.getInt(_kLastTabIndex);
      if (!mounted || saved == null) return;
      if (saved < 0 || saved > 4) return;
      setState(() => _index = saved);
    } catch (_) {}
  }

  Future<void> _saveLastTab(int i) async {
    try {
      final p = await SharedPreferences.getInstance();
      await p.setInt(_kLastTabIndex, i);
    } catch (_) {}
  }

  @override
  Widget build(BuildContext context) {
    final pages = [
      HomeScreen(api: _api),
      WorkScreen(api: _api),
      MyProductsScreen(api: _api),
      OrdersScreen(api: _api),
      MoreScreen(api: _api),
    ];

    return Scaffold(
      body: SafeArea(child: pages[_index]),
      bottomNavigationBar: Padding(
        padding: EdgeInsets.fromLTRB(
          12,
          0,
          12,
          12 + MediaQuery.of(context).padding.bottom,
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(18),
          child: NavigationBar(
            selectedIndex: _index,
            onDestinationSelected: (i) {
              setState(() => _index = i);
              _saveLastTab(i);
            },
            destinations: const [
              NavigationDestination(
                icon: Icon(Icons.home_outlined),
                selectedIcon: Icon(Icons.home),
                label: '홈',
              ),
              NavigationDestination(
                icon: Icon(Icons.work_outline),
                selectedIcon: Icon(Icons.work),
                label: '상품 업로드',
              ),
              NavigationDestination(
                icon: Icon(Icons.inventory_2_outlined),
                selectedIcon: Icon(Icons.inventory_2),
                label: '내 상품',
              ),
              NavigationDestination(
                icon: Icon(Icons.receipt_long_outlined),
                selectedIcon: Icon(Icons.receipt_long),
                label: '주문',
              ),
              NavigationDestination(
                icon: Icon(Icons.more_horiz),
                selectedIcon: Icon(Icons.more_horiz),
                label: '더보기',
              ),
            ],
          ),
        ),
      ),
    );
  }
}
