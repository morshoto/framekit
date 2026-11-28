// Research-only file inspection. A digest is not proof of sender, target, or freshness.
import CryptoKit
import Darwin
import Foundation

struct OutputObservation {
    let sha256: String
    let size: Int
}

enum OutputInspectionError: Error { case invalidInput, unavailable, changed, digestMismatch }

func inspectOutput(directory: URL, name: String, expectedDigest: String) throws -> OutputObservation {
    guard directory.isFileURL,
          name.range(of: "^[A-Za-z0-9][A-Za-z0-9._ -]{0,127}$", options: .regularExpression) != nil,
          expectedDigest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
        throw OutputInspectionError.invalidInput
    }
    let directoryFD = open(directory.path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)
    guard directoryFD >= 0 else { throw OutputInspectionError.unavailable }
    defer { close(directoryFD) }
    let fileFD = openat(directoryFD, name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
    guard fileFD >= 0 else { throw OutputInspectionError.unavailable }
    defer { close(fileFD) }
    var before = stat()
    guard fstat(fileFD, &before) == 0, (before.st_mode & S_IFMT) == S_IFREG,
          before.st_size >= 0, before.st_size <= 16 * 1024 * 1024 else { throw OutputInspectionError.unavailable }
    var hash = SHA256()
    var buffer = [UInt8](repeating: 0, count: 32 * 1024)
    var total = 0
    while true {
        let amount = read(fileFD, &buffer, buffer.count)
        guard amount >= 0 else { throw OutputInspectionError.unavailable }
        if amount == 0 { break }
        total += amount
        guard total <= 16 * 1024 * 1024 else { throw OutputInspectionError.changed }
        hash.update(data: Data(buffer.prefix(amount)))
    }
    var after = stat()
    var current = stat()
    guard fstat(fileFD, &after) == 0, fstatat(directoryFD, name, &current, AT_SYMLINK_NOFOLLOW) == 0,
          before.st_dev == current.st_dev, before.st_ino == current.st_ino,
          before.st_size == after.st_size, total == after.st_size,
          before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec,
          before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec,
          before.st_ctimespec.tv_sec == after.st_ctimespec.tv_sec,
          before.st_ctimespec.tv_nsec == after.st_ctimespec.tv_nsec else { throw OutputInspectionError.changed }
    let digest = hash.finalize().map { String(format: "%02x", $0) }.joined()
    guard digest == expectedDigest else { throw OutputInspectionError.digestMismatch }
    return OutputObservation(sha256: digest, size: total)
}
