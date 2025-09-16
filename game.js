class GameClient {
    constructor() {
        this.canvas = document.getElementById('gameCanvas');
        this.ctx = this.canvas.getContext('2d');
        this.worldImage = null;
        this.worldWidth = 2048;
        this.worldHeight = 2048;
        
        // Game state
        this.players = {};
        this.avatars = {};
        this.myPlayerId = null;
        this.websocket = null;
        
        // Viewport/camera system
        this.viewportX = 0;
        this.viewportY = 0;
        
        // Avatar rendering
        this.avatarSize = 32; // Base avatar size
        this.loadedImages = new Map(); // Cache for loaded avatar images
        
        // Rendering smoothing & animation
        this.playerRenderState = new Map(); // playerId -> { renderX, renderY, animMs, frameIndex }
        this.animationFrameDurationMs = 120; // duration per animation frame
        this.positionSmoothingPerSecond = 10; // higher = snappier interpolation
        this.lastFrameTimeMs = performance.now();
        
        // Jump state (client-side cosmetic)
        this.jumpState = {
            isJumping: false,
            elapsedMs: 0,
            durationMs: 400,
            peakOffsetPx: 12
        };
        
        this.setupCanvas();
        this.loadWorldMap();
        this.connectToServer();
        this.setupInput();
        this.startGameLoop();
    }
    
    setupCanvas() {
        // Set canvas size to fill the browser window
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
        
        // Handle window resize
        window.addEventListener('resize', () => {
            this.canvas.width = window.innerWidth;
            this.canvas.height = window.innerHeight;
        });
    }
    
    loadWorldMap() {
        this.worldImage = new Image();
        this.worldImage.onload = () => {
            console.log('World map loaded successfully');
        };
        this.worldImage.onerror = () => {
            console.error('Failed to load world map image');
        };
        this.worldImage.src = 'world.jpg';
    }
    
    setupInput() {
        this.pressedDirections = new Set();
        this.heldOrder = []; // Most-recent-first order of currently held directions
        
        const directionForKey = (key) => {
            switch (key) {
                case 'ArrowUp': return 'up';
                case 'ArrowDown': return 'down';
                case 'ArrowLeft': return 'left';
                case 'ArrowRight': return 'right';
                default: return null;
            }
        };
        
        this.onKeyDown = (e) => {
            const direction = directionForKey(e.key);
            if (e.key === ' ' || e.code === 'Space') {
                e.preventDefault();
                this.triggerJump();
                return;
            }
            if (!direction) return;
            e.preventDefault();
            
            // Track pressed keys for stop logic
            if (!this.pressedDirections.has(direction)) {
                this.pressedDirections.add(direction);
                this.heldOrder.unshift(direction);
            }
            
            // Send one move per keydown (including auto-repeat events)
            this.sendMove(direction);
            this.setMyLocalMovement(direction, true);
        };
        
        this.onKeyUp = (e) => {
            const direction = directionForKey(e.key);
            if (!direction) return;
            e.preventDefault();
            
            // Update pressed/held state
            if (this.pressedDirections.has(direction)) {
                this.pressedDirections.delete(direction);
                this.heldOrder = this.heldOrder.filter((d) => d !== direction);
            }
            
            if (this.pressedDirections.size === 0) {
                this.sendStop();
                this.setMyLocalMovement(null, false);
            } else {
                // Keep moving in most recently pressed still-held direction
                const nextDir = this.heldOrder[0];
                if (nextDir) {
                    this.sendMove(nextDir);
                    this.setMyLocalMovement(nextDir, true);
                }
            }
        };
        
        window.addEventListener('keydown', this.onKeyDown, { passive: false });
        window.addEventListener('keyup', this.onKeyUp, { passive: false });
        
        // On blur, clear keys and stop
        window.addEventListener('blur', () => {
            if (this.pressedDirections && this.pressedDirections.size > 0) {
                this.pressedDirections.clear();
                this.heldOrder = [];
                this.sendStop();
                this.setMyLocalMovement(null, false);
            }
        });
    }
    
    sendMove(direction) {
        if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) return;
        const msg = { action: 'move', direction };
        this.websocket.send(JSON.stringify(msg));
    }
    
    sendStop() {
        if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) return;
        const msg = { action: 'stop' };
        this.websocket.send(JSON.stringify(msg));
    }
    
    setMyLocalMovement(direction, isMoving) {
        if (!this.myPlayerId || !this.players[this.myPlayerId]) return;
        const me = this.players[this.myPlayerId];
        if (direction) me.facing = direction;
        me.isMoving = !!isMoving;
    }
    
    connectToServer() {
        const wsUrl = 'wss://codepath-mmorg.onrender.com';
        console.log('Connecting to game server...');
        
        this.websocket = new WebSocket(wsUrl);
        
        this.websocket.onopen = () => {
            console.log('Connected to game server');
            this.joinGame();
        };
        
        this.websocket.onmessage = (event) => {
            try {
                const message = JSON.parse(event.data);
                this.handleServerMessage(message);
            } catch (error) {
                console.error('Error parsing server message:', error);
            }
        };
        
        this.websocket.onclose = () => {
            console.log('Disconnected from game server');
        };
        
        this.websocket.onerror = (error) => {
            console.error('WebSocket error:', error);
        };
    }
    
    joinGame() {
        const joinMessage = {
            action: 'join_game',
            username: 'brittC'
        };
        
        this.websocket.send(JSON.stringify(joinMessage));
        console.log('Sent join game message');
    }
    
    handleServerMessage(message) {
        console.log('Received message:', message);
        
        switch (message.action) {
            case 'join_game':
                if (message.success) {
                    this.myPlayerId = message.playerId;
                    this.players = message.players;
                    this.avatars = message.avatars;
                    this.loadAvatarImages();
                    // Initialize render state for all known players
                    for (const id in this.players) {
                        const p = this.players[id];
                        this.ensureRenderState(id, p.x, p.y);
                    }
                    this.centerViewportOnPlayer();
                    console.log('Successfully joined game as:', message.playerId);
                } else {
                    console.error('Failed to join game:', message.error);
                }
                break;
                
            case 'player_joined':
                this.players[message.player.id] = message.player;
                this.avatars[message.avatar.name] = message.avatar;
                this.loadAvatarImage(message.avatar);
                this.ensureRenderState(message.player.id, message.player.x, message.player.y);
                break;
                
            case 'players_moved':
                Object.assign(this.players, message.players);
                // Ensure render state exists for any players we did not have before
                for (const id in message.players) {
                    const p = message.players[id];
                    this.ensureRenderState(id, p.x, p.y);
                }
                break;
                
            case 'player_left':
                delete this.players[message.playerId];
                this.playerRenderState.delete(message.playerId);
                break;
                
            default:
                console.log('Unknown message type:', message.action);
        }
    }
    
    ensureRenderState(playerId, x, y) {
        if (!this.playerRenderState.has(playerId)) {
            this.playerRenderState.set(playerId, {
                renderX: x,
                renderY: y,
                animMs: 0,
                frameIndex: 0
            });
        }
    }
    
    loadAvatarImages() {
        for (const avatarName in this.avatars) {
            this.loadAvatarImage(this.avatars[avatarName]);
        }
    }
    
    loadAvatarImage(avatar) {
        const avatarKey = avatar.name;
        if (this.loadedImages.has(avatarKey)) return;
        
        const frames = {};
        for (const direction in avatar.frames) {
            frames[direction] = avatar.frames[direction].map(base64Data => {
                const img = new Image();
                img.src = base64Data;
                return img;
            });
        }
        
        this.loadedImages.set(avatarKey, frames);
    }
    
    centerViewportOnPlayer() {
        if (!this.myPlayerId || !this.players[this.myPlayerId]) return;
        
        const myPlayer = this.players[this.myPlayerId];
        const myRender = this.playerRenderState.get(this.myPlayerId);
        const focusX = myRender ? myRender.renderX : myPlayer.x;
        const focusY = myRender ? myRender.renderY : myPlayer.y;
        const centerX = this.canvas.width / 2;
        const centerY = this.canvas.height / 2;
        
        // Calculate viewport offset to center player (smoothed position if available)
        this.viewportX = focusX - centerX;
        this.viewportY = focusY - centerY;
        
        // Clamp viewport to world boundaries
        this.viewportX = Math.max(0, Math.min(this.viewportX, this.worldWidth - this.canvas.width));
        this.viewportY = Math.max(0, Math.min(this.viewportY, this.worldHeight - this.canvas.height));
    }
    
    worldToScreen(worldX, worldY) {
        return {
            x: worldX - this.viewportX,
            y: worldY - this.viewportY
        };
    }
    
    drawWorld() {
        if (!this.worldImage) return;
        
        // Clear canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Draw the world map with viewport offset
        this.ctx.drawImage(
            this.worldImage,
            this.viewportX, this.viewportY, this.canvas.width, this.canvas.height,  // Source rectangle
            0, 0, this.canvas.width, this.canvas.height  // Destination rectangle
        );
    }
    
    drawAvatars() {
        for (const playerId in this.players) {
            const player = this.players[playerId];
            const state = this.playerRenderState.get(playerId);
            const posX = state ? state.renderX : player.x;
            const posY = state ? state.renderY : player.y;
            let screenPos = this.worldToScreen(posX, posY);
            
            // Apply jump offset only to my avatar rendering
            if (playerId === this.myPlayerId && this.jumpState.isJumping) {
                const jumpT = Math.min(1, this.jumpState.elapsedMs / this.jumpState.durationMs);
                const sine = Math.sin(jumpT * Math.PI); // 0..1..0
                const offset = sine * this.jumpState.peakOffsetPx;
                screenPos = { x: screenPos.x, y: screenPos.y - offset };
            }
            
            // Only draw if avatar is visible on screen
            if (screenPos.x > -this.avatarSize && screenPos.x < this.canvas.width + this.avatarSize &&
                screenPos.y > -this.avatarSize && screenPos.y < this.canvas.height + this.avatarSize) {
                
                this.drawAvatar(player, screenPos, state);
                this.drawUsername(player, screenPos);
            }
        }
    }
    
    drawAvatar(player, screenPos, state) {
        const avatar = this.avatars[player.avatar];
        if (!avatar || !this.loadedImages.has(player.avatar)) return;
        
        const frames = this.loadedImages.get(player.avatar);
        const direction = player.facing;
        const frameIndex = state ? state.frameIndex : (player.animationFrame || 0);
        
        let framesToUse = frames[direction];
        if (!framesToUse && direction === 'west') {
            // West direction uses flipped east frames
            framesToUse = frames.east;
        }
        
        if (!framesToUse || !framesToUse[frameIndex]) return;
        
        const avatarImg = framesToUse[frameIndex];
        
        // Calculate avatar position (center the avatar on the player position)
        const avatarX = screenPos.x - this.avatarSize / 2;
        const avatarY = screenPos.y - this.avatarSize;
        
        this.ctx.save();
        
        // Flip horizontally for west direction
        if (direction === 'west') {
            this.ctx.scale(-1, 1);
            this.ctx.drawImage(avatarImg, -avatarX - this.avatarSize, avatarY, this.avatarSize, this.avatarSize);
        } else {
            this.ctx.drawImage(avatarImg, avatarX, avatarY, this.avatarSize, this.avatarSize);
        }
        
        this.ctx.restore();
    }
    
    drawUsername(player, screenPos) {
        this.ctx.save();
        
        // Set text style
        this.ctx.font = '12px Arial';
        this.ctx.fillStyle = 'white';
        this.ctx.strokeStyle = 'black';
        this.ctx.lineWidth = 2;
        this.ctx.textAlign = 'center';
        
        // Draw text with outline
        const textY = screenPos.y - this.avatarSize - 5;
        this.ctx.strokeText(player.username, screenPos.x, textY);
        this.ctx.fillText(player.username, screenPos.x, textY);
        
        this.ctx.restore();
    }
    
    render() {
        // Integrate smoothing and animation before rendering
        const now = performance.now();
        const dtMs = Math.max(0, now - this.lastFrameTimeMs);
        const dt = dtMs / 1000;
        this.lastFrameTimeMs = now;
        
        // Smooth positions and advance animations
        for (const playerId in this.players) {
            const p = this.players[playerId];
            this.ensureRenderState(playerId, p.x, p.y);
            const st = this.playerRenderState.get(playerId);
            const t = Math.min(1, dt * this.positionSmoothingPerSecond);
            st.renderX = st.renderX + (p.x - st.renderX) * t;
            st.renderY = st.renderY + (p.y - st.renderY) * t;
            
            if (p.isMoving) {
                st.animMs += dtMs;
                while (st.animMs >= this.animationFrameDurationMs) {
                    st.animMs -= this.animationFrameDurationMs;
                    st.frameIndex = (st.frameIndex + 1) % 3; // frames 0..2
                }
            } else {
                st.animMs = 0;
                st.frameIndex = 0;
            }
        }
        
        // Keep camera centered on my player every frame (use smoothed position)
        this.centerViewportOnPlayer();
        this.drawWorld();
        this.drawAvatars();
        
        // Advance jump timing
        if (this.jumpState.isJumping) {
            this.jumpState.elapsedMs += dtMs;
            if (this.jumpState.elapsedMs >= this.jumpState.durationMs) {
                this.jumpState.isJumping = false;
                this.jumpState.elapsedMs = 0;
            }
        }
    }
    
    triggerJump() {
        if (!this.jumpState.isJumping) {
            this.jumpState.isJumping = true;
            this.jumpState.elapsedMs = 0;
        }
    }
    
    startGameLoop() {
        const gameLoop = () => {
            this.render();
            requestAnimationFrame(gameLoop);
        };
        requestAnimationFrame(gameLoop);
    }
}

// Initialize the game when the page loads
window.addEventListener('load', () => {
    new GameClient();
});
