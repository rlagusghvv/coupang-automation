// ignore_for_file: avoid_web_libraries_in_flutter, deprecated_member_use

import 'dart:async';
import 'dart:html' as html;

const bool supportsFileDownload = true;

Future<int> downloadFiles(List<dynamic> files) async {
  final body = html.document.body;
  if (body == null) return 0;

  var count = 0;
  for (final raw in files) {
    final url = (raw.url ?? '').toString().trim();
    final filename = (raw.filename ?? '').toString().trim();
    if (url.isEmpty || filename.isEmpty) continue;

    final anchor = html.AnchorElement(href: url)
      ..style.display = 'none'
      ..setAttribute('download', filename)
      ..rel = 'noopener';
    body.append(anchor);
    anchor.click();
    anchor.remove();
    count += 1;
    await Future<void>.delayed(const Duration(milliseconds: 120));
  }
  return count;
}
