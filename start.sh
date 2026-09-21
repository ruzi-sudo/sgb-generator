#!/bin/bash
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

nvm use system &>/dev/null
nohup pnpm start > sys.log 2>&1 &
nohup cloudflared tunnel run --token eyJhIjoiMzg2MDc5Y2NkY2FiYTlhMzNiYmUyOTY2M2NjOGNiMDYiLCJ0IjoiZjM0ZDM1MzYtMDY5Ni00MGRlLTkzOGItNTIzNmI0Y2JiYjE0IiwicyI6Ik5EY3pNemhrWWpZdE9HRTVaQzAwTlRkakxXRTRaR1V0Tm1ZMVpEQmpPVFl3TW1ZMiJ9 > ~/code/sgb-generator/cloudflared.log 2>&1 &


