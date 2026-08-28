
import MapDivisionNode_ from './division-node';

//get rid of compiler mess
var MapDivisionNode = MapDivisionNode_;


var MapRefFrame = function(map, json) {
    this.map = map;
    this.valid = false;
    this.id = json['id'] || null;
    this.description = json['description'] || '';
    this.nodesMap = [];

    var model = json['model'];

    if (model == null) {
        return;
    }

    this.model = {
        physicalSrs : map.getMapsSrs(model['physicalSrs']),
        navigationSrs : map.getMapsSrs(model['navigationSrs']),
        publicSrs : map.getMapsSrs(model['publicSrs'])
    };

    this.body = json['body'] ? map.getBody(json['body']) : null;

    this.params = {};

    if (json['parameters'] != null) {
        var params = json['parameters'];
        this.params.metaBinaryOrder = params['metaBinaryOrder'] || 1;
        this.params.navDelta = params['navDelta'] || 8;
    }

    var division = json['division'];

    if (division == null) {
        return;
    }

    this.division = {
        rootLod : division['rootLod'] || 0,
        arity : division['arity'] || null,
        heightRange : division['heightRange'] || [0,1]
    };

    var extents = this.parseSpaceExtents(division['extents']);
    this.division.extents = extents;

    map.spaceExtentSize = [extents.ur[0] - extents.ll[0], extents.ur[1] - extents.ll[1], extents.ur[2] - extents.ll[2]];
    map.spaceExtentOffset = extents.ll;

    var divisionNodes = division['nodes'];
    this.division.nodes = [];

    if (divisionNodes == null) {
        return;
    }

    this.hasPoles = (divisionNodes.length == 4); 

    for (var i = 0, li = divisionNodes.length; i < li; i++) {
        var node = this.parseNode(divisionNodes[i]);
        this.nodesMap['' + node.id[0] + '.'  + node.id[1] + '.' + node.id[2]] = node;
        this.division.nodes.push(node);
    }

    this.valid = true;
};


MapRefFrame.prototype.getInfo = function() {
    return {
        'id' : this.id,
        'physicalSrs' : this.model.physicalSrs.id,
        'navigationSrs' : this.model.navigationSrs.id,
        'publicSrs' : this.model.publicSrs.id
    };
};


MapRefFrame.prototype.getGlobalHeightRange = function() {
    return this.division.heightRange;     
};


MapRefFrame.prototype.parseNode = function(nodeData) {
    var node = {
        srs : nodeData['srs'],
        partitioning : nodeData['partitioning']
    };

    node.extents = this.parseExtents(nodeData['extents']);

    var nodeId = nodeData['id'];

    if (nodeId == null) {
        return;
    }

    node.id = {
        lod : nodeId['lod'] || 0,
        position : nodeId['position'] || [0,0]
    };

    return new MapDivisionNode(this.map, [node.id.lod, node.id.position[0], node.id.position[1]],
                                           node.srs, node.extents, this.heightRange, node.partitioning);
};


MapRefFrame.prototype.parseExtents = function(extentsData) {
    if (extentsData == null) {
        return { ll : [0,0], ur : [1,1] };
    }

    return {
        ll : extentsData['ll'] || [0,0],
        ur : extentsData['ur'] || [1,1]
    };
};


MapRefFrame.prototype.parseSpaceExtents = function(extentsData) {
    if (extentsData == null) {
        return { ll : [0,0,0], ur : [1,1,1] };
    }

    return {
        ll : extentsData['ll'] || [0,0,0],
        ur : extentsData['ur'] || [1,1,1]
    };
};


MapRefFrame.prototype.getSpatialDivisionNodes = function() {
    return this.division.nodes;
};


/** Returns the deepest spatial division node containing a tile id. */
MapRefFrame.prototype.getSpatialDivisionNodeForTile = function(tileId) {
    var owner = null;
    var nodes = this.division.nodes;

    for (var i = 0, li = nodes.length; i < li; i++) {
        var node = nodes[i];
        var shift = tileId[0] - node.id[0];

        if (shift < 0 || (tileId[1] >> shift) !== node.id[1]
            || (tileId[2] >> shift) !== node.id[2]) {

            continue;
        }

        if (!owner || node.id[0] > owner.id[0]) owner = node;
    }

    return owner;
};


/** Returns one nominal sample's side at a node tile LOD. */
MapRefFrame.prototype.getNodeGsd = function(node, lod, sampleCount) {
    var ll = node.extents.ll;
    var ur = node.extents.ur;
    var rootSide = Math.sqrt((ur[0] - ll[0]) * (ur[1] - ll[1]));

    return rootSide
        / (sampleCount * Math.pow(2, lod - node.id[0]));
};


/**
 * Resolves a navigation-SRS position to the spatial division nodes that
 * own it, with its coordinates in each node's own SRS.
 *
 * Node extents overlap; the partitioning range a node inherits from a
 * manually partitioning parent bounds what it actually serves, and a
 * node bounded that way is returned only when its range contains the
 * position.
 *
 * @param coords navigation-SRS coordinates
 * @returns array of { node, coords } by descending node LOD; empty
 *     outside every node
 */
MapRefFrame.prototype.resolveSpatialDivisionNodes = function(coords) {
    var nodes = this.division.nodes;
    var owners = [];

    for (var i = 0, li = nodes.length; i < li; i++) {
        var node = nodes[i];
        var nodeCoords = node.getInnerCoords(coords);
        var extents = node.extents;

        if (nodeCoords[0] < extents.ll[0] || nodeCoords[0] > extents.ur[0] ||
            nodeCoords[1] < extents.ll[1] || nodeCoords[1] > extents.ur[1]) {

            continue;
        }

        if (!this.withinPartitioningRange(node, coords)) {
            continue;
        }

        owners.push({ node: node, coords: nodeCoords });
    }

    owners.sort(function(a, b) { return b.node.id[0] - a.node.id[0]; });

    return owners;
};


/**
 * Whether a position lies inside the partitioning range a node inherits
 * from its parent. True when there is no such range, in which case the
 * node's extents already bound it.
 *
 * @param coords navigation-SRS coordinates
 */
MapRefFrame.prototype.withinPartitioningRange = function(node, coords) {
    if (node.partitioningRange === undefined) {
        node.partitioningRange = this.resolvePartitioningRange(node);
    }

    var range = node.partitioningRange;
    if (!range) {
        return true;
    }

    var parentCoords = range.node.getInnerCoords(coords);

    return parentCoords[0] >= range.ll[0] && parentCoords[0] <= range.ur[0]
        && parentCoords[1] >= range.ll[1] && parentCoords[1] <= range.ur[1];
};


/**
 * The range a manually partitioning parent assigns to one of its
 * children, in that parent's SRS. Null when the node has no such
 * parent.
 */
MapRefFrame.prototype.resolvePartitioningRange = function(node) {
    var id = node.id;
    if (id[0] === 0) {
        return null;
    }

    var parent = this.nodesMap['' + (id[0] - 1) + '.' + (id[1] >> 1)
        + '.' + (id[2] >> 1)];

    if (!parent || typeof parent.partitioning !== 'object') {
        return null;
    }

    // ranges are keyed by the child's position under the parent, with
    // each coordinate 0 or 1
    var range = parent.partitioning['' + (id[1] & 1) + (id[2] & 1)];

    if (!range || !range.ll || !range.ur) {
        return null;
    }

    return { node: parent, ll: range.ll, ur: range.ur };
};


/**
 * Locates a position inside the tile grid of one spatial division node.
 *
 * `uv` comes back with u growing east and v south, the orientation of a
 * tile's external texture coordinates.
 *
 * @param coords position in that node's own SRS
 * @param lod tile LOD, at or below the node's own LOD
 * @param uv two-element array receiving the position within the tile
 * @returns the tile id [lod, x, y] containing the position
 */
MapRefFrame.prototype.getNodeTileAt = function(node, coords, lod, uv) {
    var shift = lod - node.id[0];
    var tiles = Math.pow(2, shift);

    var ll = node.extents.ll;
    var ur = node.extents.ur;

    var cellWidth = (ur[0] - ll[0]) / tiles;
    var cellHeight = (ur[1] - ll[1]) / tiles;

    var fx = (coords[0] - ll[0]) / cellWidth;
    var fy = (ur[1] - coords[1]) / cellHeight;

    // a position exactly on the node's far edge belongs to the last tile
    var ix = Math.min(Math.floor(fx), tiles - 1);
    var iy = Math.min(Math.floor(fy), tiles - 1);

    uv[0] = fx - ix;
    uv[1] = fy - iy;

    return [lod, (node.id[1] * tiles) + ix, (node.id[2] * tiles) + iy];
};


MapRefFrame.prototype.convertCoords = function(coords, source, destination) {
    var sourceSrs, destinationSrs;

    switch(source) {
    case 'public':     sourceSrs = this.model.publicSrs;     break;
    case 'physical':   sourceSrs = this.model.physicalSrs;   break;
    case 'navigation': sourceSrs = this.model.navigationSrs; break;
    }

    switch(destination) {
    case 'public':     destinationSrs = this.model.publicSrs;     break;
    case 'physical':   destinationSrs = this.model.physicalSrs;   break;
    case 'navigation': destinationSrs = this.model.navigationSrs; break;
    }

    return sourceSrs.convertCoordsTo(coords, destinationSrs);
};


export default MapRefFrame;

