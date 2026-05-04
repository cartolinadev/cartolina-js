/* vts-browser-js demo: full-screen map, crosshair cursor, elevation & depth overlay */
(function () {
  var browser = cartolina.browser('map', {
    map: 'https://cdn.tspl.re/store/a-3d-mountain-map/map-config/map/mapConfig.json',
    position: ['obj', -118.302348, 36.560197, 'fix', 3313.32, -133.38, -25.09, 0.00, 33347.92, 45.00],
    controlSearch: false,
    controlCompass: false,
    controlMeasure: false,
    controlZoom: false,
    controlSpace: false,
    controlFallback: false
  });

  if (!browser) { console.error('WebGL not supported'); return; }

  var overlay = document.getElementById('overlay');

  function updateOverlay(e) {
    if (!browser) return;

    // 1) Surface hit in navigation coords (gives absolute elevation in meters)
    var xy = e.getMouseCoords();                // CSS pixels relative to canvas
    var nav = browser.getHitCoords(xy[0], xy[1], 'fix');

    // 2) Direct screen-space depth (meters) via depth buffer
    var depthApi = browser.getScreenDepth(xy[0], xy[1], 1 /*dilate px*/);
    var depthApiStr = '—';
    if (depthApi && depthApi[0]) {
      depthApiStr = depthApi[1].toFixed(2) + ' m';
    }

    if (nav) {

      // 3) Depth via camera-space vector length (as a cross-check)
      var pub = browser.convertCoordsFromNavToPublic(nav, 'fix');
      var phys = browser.convertCoordsFromNavToPhys(nav, 'fix');     // world coords [x,y,z]
      var camVec = browser.convertCoordsFromPhysToCameraSpace(phys); // vector camera->point
      var depthVecM = Math.hypot(camVec[0], camVec[1], camVec[2]);

      overlay.innerHTML =
        'Elevation: <b>' + pub[2].toFixed(2) + ' m</b> · ' +
        'Depth(vec): <b>' + depthVecM.toFixed(2) + ' m</b> · ' +
        'Depth(api): <b>' + depthApiStr + '</b>';
    } else {
      overlay.innerHTML =
        'Elevation: <b>— m</b> · Depth(vec): <b>— m</b> · Depth(api): <b>' + depthApiStr + '</b>';
    }
  }

  var el = browser.ui.getMapElement();
  el.on('mousemove', updateOverlay);
  el.on('mouseleave', function () {
    overlay.innerHTML =
      'Elevation: <b>— m</b> · Depth(vec): <b>— m</b> · Depth(api): <b>—</b>';
  });
})();
