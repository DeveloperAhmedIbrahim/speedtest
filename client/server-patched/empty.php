<?php

/*
 * empty.php — LibreSpeed's latency + upload sink, with two additions:
 *  - Timing-Allow-Origin so the browser can read precise Resource Timing values
 *    (this is what makes the ping number sharp rather than approximate).
 *  - The request body is read and discarded explicitly, so a large POST does not
 *    depend on post_max_size being generous.
 */

@ini_set('zlib.output_compression', 'Off');

header('HTTP/1.1 200 OK');

if (isset($_GET['cors'])) {
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST');
    header('Access-Control-Allow-Headers: Content-Encoding, Content-Type');
}

header('Timing-Allow-Origin: *');

header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0, s-maxage=0');
header('Cache-Control: post-check=0, pre-check=0', false);
header('Pragma: no-cache');
header('Connection: keep-alive');
header('Content-Length: 0');

// Drain the upload body without buffering it anywhere.
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $in = @fopen('php://input', 'rb');
    if ($in) {
        while (!feof($in)) {
            if (fread($in, 262144) === false) {
                break;
            }
        }
        fclose($in);
    }
}
