

import MapTexture_ from './texture';
import MapSubtexture_ from './subtexture';
import MapMetatile_ from './metatile';
import MapMesh_ from './mesh';
import MapGeodata_ from './geodata';
import MapPointCloud_ from './pointcloud';

//get rid of compiler mess
var MapTexture = MapTexture_;
var MapSubtexture = MapSubtexture_;
var MapMetatile = MapMetatile_;
var MapMesh = MapMesh_;
var MapGeodata = MapGeodata_;
var MapPointCloud = MapPointCloud_;

export class MapResourceNode {

constructor(map, parent, id) {
    this.map = map;
    this.id = id;
    this.parent = parent;

    this.metatiles = {}
    this.meshes = {}
    this.textures = {}
    this.subtextures = {}
    this.geodata = {}
    this.credits = {}

    this.children = [null, null, null, null];
}


kill() {
    //kill children
    for (var i = 0; i < 4; i++) {
        if (this.children[i] != null) {
            this.children[i].kill();
        }
    }

    this.children = [null, null, null, null];

    var parent = this.parent;
    this.parent = null;

    if (parent != null) {
        parent.removeChild(this);
    }
    
    //kill resources?
}


addChild(index) {
    if (this.children[index]) {
        return;
    }
    
    var id = this.id;
    var childId = [id[0] + 1, id[1] << 1, id[2] << 1];

    switch (index) {
    case 1: childId[1]++; break;
    case 2: childId[2]++; break;
    case 3: childId[1]++; childId[2]++; break;
    }

    this.children[index] = new MapResourceNode(this.map, this, childId);
}


removeChildByIndex(index) {
    if (this.children[index] != null) {
        this.children[index].kill();
        this.children[index] = null;
    }
}


removeChild(tile) {
    for (var i = 0; i < 4; i++) {
        if (this.children[i] == tile) {
            this.children[i].kill();
            this.children[i] = null;
        }
    }
}


// Meshes ---------------------------------


getMesh(path, tile) {
    var mesh = this.meshes[path];
    
    if (!mesh) {
        mesh = new MapMesh(this.map, path, tile);
        this.meshes[path] = mesh;
    }
    
    return mesh;
}


// Point Clouds ---------------------------------


getPointCloud(path, tile, offset, size) {
    if (!this.pointclouds) this.pointclouds = {}

    var path2 = offset ? path+'@'+offset : path;
    var pointcloud = this.pointclouds[path2];
    
    if (!pointcloud) {
        pointcloud = new MapPointCloud(this.map, path, tile, offset, size);
        this.pointclouds[path2] = pointcloud;
    }
    
    return pointcloud;
}


// Geodata ---------------------------------


getGeodata(path, extraInfo) {
    var geodata = this.geodata[path];
    
    if (!geodata) {
        geodata = new MapGeodata(this.map, path, extraInfo);
        this.geodata[path] = geodata;
    }
    
    return geodata;
}


// Textures ---------------------------------


getTexture(path, type, extraBound, extraInfo, tile, internal) {
    var texture;
    if (extraInfo && (extraInfo.layer || extraInfo.hmap)) {
        var id = path + (extraInfo.hmap ? '' : extraInfo.layer.id);
        texture = this.textures[id];
        
        if (!texture) {
            texture = new MapTexture(this.map, path, type, extraBound, extraInfo, tile, internal);
            this.textures[id] = texture;
        }
    } else {
        texture = this.textures[path];
        
        if (!texture) {
            texture = new MapTexture(this.map, path, type, extraBound, extraInfo, tile, internal);
            this.textures[path] = texture;
        }
    }
    
    return texture;
}


// SubTextures ---------------------------------


getSubtexture(texture, path, type, extraBound, extraInfo, tile, internal) {
    texture = this.subtextures[path];
    
    if (!texture) {
        texture = new MapSubtexture(this.map, path, type, extraBound, extraInfo, tile, internal);
        this.subtextures[path] = texture;
    }
    
    return texture;
}


// Metatiles ---------------------------------


addMetatile(path, metatile) {
    this.metatiles[path] = metatile;
}



removeMetatile(metatile) {
    for (var key in this.metatiles) {
        if (this.metatiles[key] == metatile) {
            delete this.metatiles[key];
        }
    }
}



getMetatile(surface, allowCreation, tile) {
    var metatiles = this.metatiles, metatile; 
    for (var key in metatiles) {
        if (metatiles[key].surface == surface) {
            return metatiles[key];
        } 
    }
    
    var path = surface.getMetaUrl(this.id);

    if (metatiles[path]) {
        metatile = metatiles[path].clone(surface);
        this.addMetatile(path, metatile);
        return metatile;
    }

    if (allowCreation) {
        metatile = new MapMetatile(this, surface, tile);
        this.addMetatile(path, metatile);
        return metatile; 
    } else {
        return null;
    }
}

} // class MapResourceNode


export default MapResourceNode;



