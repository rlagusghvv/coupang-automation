import 'dart:typed_data';

import 'video_file_pick_stub.dart'
    if (dart.library.html) 'video_file_pick_web.dart' as impl;

class PickedVideoFile {
  const PickedVideoFile({
    required this.name,
    required this.mimeType,
    required this.bytes,
  });

  final String name;
  final String mimeType;
  final Uint8List bytes;
}

bool get supportsVideoFilePick => impl.supportsVideoFilePick;

Future<PickedVideoFile?> pickVideoFile() => impl.pickVideoFile();
