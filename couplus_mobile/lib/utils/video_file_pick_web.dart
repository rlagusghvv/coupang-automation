// ignore_for_file: avoid_web_libraries_in_flutter, deprecated_member_use

import 'dart:async';
import 'dart:html' as html;
import 'dart:typed_data';

import 'video_file_pick.dart';

const bool supportsVideoFilePick = true;

Future<PickedVideoFile?> pickVideoFile() async {
  final input = html.FileUploadInputElement()
    ..accept = 'video/mp4,video/*,.mp4,.mov,.m4v'
    ..multiple = false;

  final completer = Completer<PickedVideoFile?>();
  input.onChange.first.then((_) {
    final file = input.files == null || input.files!.isEmpty ? null : input.files!.first;
    if (file == null) {
      completer.complete(null);
      return;
    }
    final reader = html.FileReader();
    reader.onError.first.then((_) {
      if (!completer.isCompleted) {
        completer.completeError(StateError('video_file_read_failed'));
      }
    });
    reader.onLoadEnd.first.then((_) {
      final result = reader.result;
      if (result is! ByteBuffer) {
        completer.completeError(StateError('video_file_read_failed'));
        return;
      }
      completer.complete(
        PickedVideoFile(
          name: file.name,
          mimeType: file.type,
          bytes: Uint8List.view(result),
        ),
      );
    });
    reader.readAsArrayBuffer(file);
  });

  input.click();
  return completer.future;
}
