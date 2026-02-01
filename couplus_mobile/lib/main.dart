import 'package:couplus_mobile/api/api_client.dart';
import 'package:couplus_mobile/screens/home_screen.dart';
import 'package:couplus_mobile/screens/more_screen.dart';
import 'package:couplus_mobile/screens/work_screen.dart';
import 'package:flutter/material.dart';

void main() {
  runApp(const CouplusApp());
}

class CouplusApp extends StatelessWidget {
  const CouplusApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Couplus',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.indigo),
        useMaterial3: true,
        brightness: Brightness.light,
      ),
      darkTheme: ThemeData(
        colorScheme: ColorScheme.fromSeed(
          seedColor: Colors.indigo,
          brightness: Brightness.dark,
        ),
        useMaterial3: true,
        brightness: Brightness.dark,
      ),
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
  Widget build(BuildContext context) {
    final pages = [
      HomeScreen(api: _api),
      WorkScreen(api: _api),
      MoreScreen(api: _api),
    ];

    return Scaffold(
      body: SafeArea(child: pages[_index]),
      bottomNavigationBar: BottomNavigationBar(
        currentIndex: _index,
        onTap: (i) => setState(() => _index = i),
        items: const [
          BottomNavigationBarItem(icon: Icon(Icons.home), label: 'Home'),
          BottomNavigationBarItem(icon: Icon(Icons.work), label: 'Work'),
          BottomNavigationBarItem(icon: Icon(Icons.more_horiz), label: 'More'),
        ],
      ),
    );
  }
}
