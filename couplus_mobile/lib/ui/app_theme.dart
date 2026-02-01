import 'package:flutter/material.dart';

class AppTheme {
  static const seed = Color(0xFF3B5BDB);

  static const bg = Color(0xFFF4F6F8);
  static const card = Colors.white;

  static ThemeData light() {
    final cs = ColorScheme.fromSeed(seedColor: seed, brightness: Brightness.light);

    return ThemeData(
      useMaterial3: true,
      colorScheme: cs,
      scaffoldBackgroundColor: bg,
      appBarTheme: const AppBarTheme(
        backgroundColor: bg,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        centerTitle: false,
        titleTextStyle: TextStyle(
          fontSize: 18,
          fontWeight: FontWeight.w700,
          color: Colors.black,
        ),
      ),
      cardTheme: CardThemeData(
        color: card,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
        margin: EdgeInsets.zero,
      ),
      dividerTheme: DividerThemeData(
        color: Colors.black.withValues(alpha: 0.06),
        thickness: 1,
        space: 1,
      ),
      textTheme: const TextTheme(
        titleLarge: TextStyle(fontSize: 20, fontWeight: FontWeight.w800),
        titleMedium: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
        bodyMedium: TextStyle(fontSize: 14, height: 1.35),
        labelLarge: TextStyle(fontSize: 14, fontWeight: FontWeight.w700),
      ),
    );
  }

  static ThemeData dark() {
    final cs = ColorScheme.fromSeed(seedColor: seed, brightness: Brightness.dark);
    return ThemeData(
      useMaterial3: true,
      colorScheme: cs,
      scaffoldBackgroundColor: const Color(0xFF0D1117),
      cardTheme: CardThemeData(
        color: const Color(0xFF111827),
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
        margin: EdgeInsets.zero,
      ),
    );
  }
}
