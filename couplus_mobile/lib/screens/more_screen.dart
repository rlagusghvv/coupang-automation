import 'package:couplus_mobile/api/api_client.dart';
import 'package:flutter/material.dart';

class MoreScreen extends StatelessWidget {
  const MoreScreen({super.key, required this.api});

  final ApiClient api;

  @override
  Widget build(BuildContext context) {
    return ListView(
      padding: const EdgeInsets.all(16),
      children: [
        Text('More', style: Theme.of(context).textTheme.headlineSmall),
        const SizedBox(height: 12),
        Card(
          child: ListTile(
            title: const Text('Server address'),
            subtitle: Text(ApiClient.defaultBaseUrl),
            trailing: const Icon(Icons.lock_outline),
          ),
        ),
        const SizedBox(height: 12),
        Card(
          child: ListTile(
            title: const Text('Dashboard endpoint'),
            subtitle: Text('${ApiClient.defaultBaseUrl}/api/dashboard'),
          ),
        ),
        const SizedBox(height: 24),
        const Text(
          'Note: Auth (cookie session) is not wired up yet in this mobile scaffold.',
        ),
      ],
    );
  }
}
