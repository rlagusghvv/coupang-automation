import 'package:flutter/material.dart';

class AppButton extends StatelessWidget {
  const AppButton({
    super.key,
    required this.label,
    this.onPressed,
    this.color,
  });

  final String label;
  final VoidCallback? onPressed;
  final Color? color;

  @override
  Widget build(BuildContext context) {
    final c = color;
    if (c == null) {
      return FilledButton(
        onPressed: onPressed,
        child: Text(label),
      );
    }

    return FilledButton(
      style: FilledButton.styleFrom(backgroundColor: c),
      onPressed: onPressed,
      child: Text(label),
    );
  }
}
