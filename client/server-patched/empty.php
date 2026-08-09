<?php

/*
 * empty.php — LibreSpeed's latency endpoint and upload sink.
 *
 * This is the stock behaviour plus one header. Note what it does NOT do: it does
 * not read the request body. An earlier version of this file drained
 * php://input in a fread loop, which is unnecessary (the web server discards the
 * body on its own) and on LiteSpeed / cPanel it is catastrophically slow — a 2MB
 * POST went from ~2s to ~20s, which collapsed the measured upload speed.
 *
 * If you are debugging a slow upload, this file should stay boring.
 */

@ini_set('zlib.output_compression', 'Off');

header('HTTP/1.1 200 OK');

if (isset($_GET['cors'])) {
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST');
    header('Access-Control-Allow-Headers: Content-Encoding, Content-Type');
}

// The one addition over stock: lets the browser read precise Resource Timing
// values, which is what makes the ping reading sharp rather than approximate.
header('Timing-Allow-Origin: *');

header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0, s-maxage=0');
header('Cache-Control: post-check=0, pre-check=0', false);
header('Pragma: no-cache');
header('Connection: keep-alive');
header('Content-Length: 0');
