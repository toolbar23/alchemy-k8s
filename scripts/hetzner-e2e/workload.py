#!/usr/bin/env python3
import argparse
import http.server
import json
import os
import socket
import time
import urllib.request


def emit(payload):
    print(json.dumps(payload, sort_keys=True), flush=True)


def dns(args):
    samples = []
    for _ in range(args.count):
        started = time.perf_counter_ns()
        socket.getaddrinfo(args.host, None)
        samples.append((time.perf_counter_ns() - started) / 1_000_000)
    started = time.perf_counter_ns()
    with urllib.request.urlopen(args.url, timeout=15) as response:
        response.read(64)
        status = response.status
    emit(
        {
            "dnsMs": samples,
            "egressMs": (time.perf_counter_ns() - started) / 1_000_000,
            "egressStatus": status,
        }
    )


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({"path": self.path, "node": socket.gethostname()}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format, *_args):
        return


def http_server(args):
    http.server.ThreadingHTTPServer(("0.0.0.0", args.port), Handler).serve_forever()


def tcp_server(args):
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(("0.0.0.0", args.port))
    listener.listen(8)
    while True:
        connection, _ = listener.accept()
        with connection:
            while connection.recv(1024 * 1024):
                pass


def tcp_client(args):
    remaining = args.size_mib * 1024 * 1024
    block = b"x" * (1024 * 1024)
    started = time.perf_counter_ns()
    with socket.create_connection((args.host, args.port), timeout=15) as connection:
        while remaining > 0:
            sent = connection.send(block[: min(len(block), remaining)])
            remaining -= sent
    elapsed = (time.perf_counter_ns() - started) / 1_000_000_000
    emit(
        {
            "sizeMiB": args.size_mib,
            "seconds": elapsed,
            "throughputMiBps": args.size_mib / elapsed,
        }
    )


def storage(args):
    data_path = os.path.join(args.path, "benchmark.bin")
    marker_path = os.path.join(args.path, "marker.txt")
    block = b"s" * (1024 * 1024)
    started = time.perf_counter_ns()
    with open(data_path, "wb", buffering=0) as output:
        for _ in range(args.size_mib):
            output.write(block)
        os.fsync(output.fileno())
    write_seconds = (time.perf_counter_ns() - started) / 1_000_000_000
    with open(marker_path, "w", encoding="utf-8") as marker:
        marker.write(args.marker)
        marker.flush()
        os.fsync(marker.fileno())
    started = time.perf_counter_ns()
    read_bytes = 0
    with open(data_path, "rb", buffering=0) as source:
        while chunk := source.read(1024 * 1024):
            read_bytes += len(chunk)
    read_seconds = (time.perf_counter_ns() - started) / 1_000_000_000
    emit(
        {
            "marker": args.marker,
            "sizeMiB": read_bytes / 1024 / 1024,
            "writeMiBps": args.size_mib / write_seconds,
            "readMiBps": (read_bytes / 1024 / 1024) / read_seconds,
        }
    )


def verify_storage(args):
    marker_path = os.path.join(args.path, "marker.txt")
    with open(marker_path, encoding="utf-8") as marker:
        actual = marker.read()
    if actual != args.marker:
        raise RuntimeError(f"persistent marker mismatch: {actual!r}")
    emit({"marker": actual, "persistent": True})


parser = argparse.ArgumentParser()
subparsers = parser.add_subparsers(dest="command", required=True)

dns_parser = subparsers.add_parser("dns")
dns_parser.add_argument("--host", required=True)
dns_parser.add_argument("--url", default="https://www.hetzner.com/")
dns_parser.add_argument("--count", type=int, default=20)
dns_parser.set_defaults(run=dns)

http_parser = subparsers.add_parser("http-server")
http_parser.add_argument("--port", type=int, default=8080)
http_parser.set_defaults(run=http_server)

tcp_server_parser = subparsers.add_parser("tcp-server")
tcp_server_parser.add_argument("--port", type=int, default=9000)
tcp_server_parser.set_defaults(run=tcp_server)

tcp_client_parser = subparsers.add_parser("tcp-client")
tcp_client_parser.add_argument("--host", required=True)
tcp_client_parser.add_argument("--port", type=int, default=9000)
tcp_client_parser.add_argument("--size-mib", type=int, default=256)
tcp_client_parser.set_defaults(run=tcp_client)

storage_parser = subparsers.add_parser("storage")
storage_parser.add_argument("--path", default="/data")
storage_parser.add_argument("--size-mib", type=int, default=256)
storage_parser.add_argument("--marker", required=True)
storage_parser.set_defaults(run=storage)

verify_parser = subparsers.add_parser("verify-storage")
verify_parser.add_argument("--path", default="/data")
verify_parser.add_argument("--marker", required=True)
verify_parser.set_defaults(run=verify_storage)

arguments = parser.parse_args()
arguments.run(arguments)
