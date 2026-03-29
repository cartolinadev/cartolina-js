
import { browser, configFromUrl } from "../../../build/cartolina.esm.js";

async function startBrowser() {

    var params_;

    try {
        params_ = configFromUrl({
            jumpAllowed: true,
            positionInUrl: true,
            controlSearchUrl: 'https://nominatim.openstreetmap.org/search.php?q={value}&format=json&limit=20',
            controlSearchFilter: false
        }, window.location.href, {
            requireMap: true
        });
    } catch (error) {
        alert(error.message);
        return;
    }

    document.title = document.title + " — " + params_['map'];

    if (params_['screenshot']) {
        params_['controlLoading'] = false;
    }
    
    let browser_ = browser('map-canvas', params_);
    //await browser_.ready;
}

export default startBrowser;
