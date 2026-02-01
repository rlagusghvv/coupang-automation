import 'package:couplus_mobile/api/api_client.dart';
import 'package:couplus_mobile/screens/home_screen.dart';
import 'package:couplus_mobile/screens/more_screen.dart';
import 'package:couplus_mobile/screens/work_screen.dart';
import 'package:couplus_mobile/ui/app_theme.dart';
import 'package:flutter/material.dart';

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
  int _index = 0;

  late final ApiClient _api = ApiClient();

  @override
  void initState() {
    super.initState();
    _api.init();
  }

  @override
  Widget build(BuildContext context) {
    final pages = [
      HomeScreen(api: _api),
      WorkScreen(api: _api),
      MoreScreen(api: _api),
    ];

    return Scaffold(
      body: SafeArea(child: pages[_index]),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.home_outlined), selectedIcon: Icon(Icons.home), label: 'Home'),
          NavigationDestination(icon: Icon(Icons.work_outline), selectedIcon: Icon(Icons.work), label: 'Work'),
          NavigationDestination(icon: Icon(Icons.more_horiz), selectedIcon: Icon(Icons.more_horiz), label: 'More'),
        ],
      ),
    );
  }
}
