import 'package:couplus_mobile/ui/widgets.dart';
import 'package:flutter/material.dart';

class VendorRow extends StatelessWidget {
  const VendorRow({
    super.key,
    required this.title,
    required this.json,
    this.onReset,
  });

  final String title;
  final Map<String, dynamic>? json;
  final VoidCallback? onReset;

  @override
  Widget build(BuildContext context) {
    final st = (json?['status'] as Map?)?.cast<String, dynamic>() ?? {};
    final exists = st['exists'] == true;
    final loggedIn = st['loggedIn'] == true;
    final updatedAt = (st['updatedAt'] ?? '').toString();

    Color c = Theme.of(context).colorScheme.outline;
    String label = '미확인';
    if (!exists) {
      c = const Color(0xFFE03131);
      label = '세션 없음';
    } else if (loggedIn) {
      c = const Color(0xFF2F9E44);
      label = '정상';
    } else {
      c = const Color(0xFFE03131);
      label = '만료/로그인 필요';
    }

    return Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text(title, style: const TextStyle(fontWeight: FontWeight.w900)),
                  const SizedBox(width: 8),
                  InfoChip(label: label, color: c),
                ],
              ),
              if (updatedAt.trim().isNotEmpty) ...[
                const SizedBox(height: 4),
                Text(
                  '갱신: $updatedAt',
                  style: TextStyle(
                    fontSize: 12,
                    color: Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.6),
                  ),
                ),
              ],
            ],
          ),
        ),
        TextButton(
          onPressed: onReset,
          child: const Text('초기화'),
        ),
      ],
    );
  }
}
