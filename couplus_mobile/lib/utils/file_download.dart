import 'file_download_stub.dart' if (dart.library.html) 'file_download_web.dart'
    as impl;

class DownloadFileSpec {
  const DownloadFileSpec({required this.url, required this.filename});

  final String url;
  final String filename;
}

bool get supportsFileDownload => impl.supportsFileDownload;

Future<int> downloadFiles(List<DownloadFileSpec> files) =>
    impl.downloadFiles(files);
