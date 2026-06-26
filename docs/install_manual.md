MagicMirror² + MMM-EmbedURL 설치 및 설정 메뉴얼
Raspberry Pi (라즈비안 OS) 기준 · 로컬 HTML Report 서빙 · nginx 네이티브 설치
작성일: 2026년 3월
---
목차
운영환경 설정
모듈 설치
모듈 설정
MagicMirror 실행
---
1. 운영환경 설정
1.1 시스템 요구사항

---
1.2 OS 초기 설정
라즈비안 OS 설치 후 아래 초기 설정을 수행합니다.
패키지 업데이트
sudo apt update && sudo apt upgrade -y
한글설치
# 한글 폰트 설치
sudo apt install fonts-nanum -y

# 타임존/로케일 설정
sudo timedatectl set-timezone Asia/Seoul

sudo sed -i 's/^# *\(ko_KR.UTF-8\)/\1/' /etc/locale.gen
sudo locale-gen
sudo localectl set-locale LANG=ko_KR.UTF-8  

# 재부팅
sudo reboot
Node.js 설치
Node.js v18 LTS를 NodeSource를 통해 설치합니다.
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# 버전 확인
node -v && npm -v

Git 설치
sudo apt install -y git

nginx 설치
HTML Report를 HTTP로 서빙하기 위해 nginx를 apt로 설치합니다.
sudo apt install -y nginx

# 버전 확인
nginx -v

# 서비스 자동시작 설정
sudo systemctl enable nginx
sudo systemctl start nginx

디스플레이 환경 설정(Graphic이 없는 경우)
X서버 없이 MagicMirror를 실행하는 경우 아래 패키지를 설치합니다.
sudo apt install -y xorg openbox

# 자동 로그인 설정 (옵션)
sudo raspi-config
# → 1 System Options → S5 Boot / Auto Login → B4 Desktop Autologin

---
2. 모듈 설치
2.1 MagicMirror 설치
공식 MagicMirror² 저장소를 클론하고 의존성을 설치합니다.
# 홈 디렉토리로 이동
cd ~

# 저장소 클론
git clone https://github.com/MagicMirrorOrg/MagicMirror
cd MagicMirror

# 의존성 설치 (시간 소요 약 5~10분)
npm run install-mm

💡 npm run install-mm 은 electron 포함 전체 의존성을 설치합니다. 네트워크 상태에 따라 시간이 소요될 수 있습니다.
설치되면 아래 명령어로 실행을 확인합니다.

---
2.2 MMM-EmbedURL 서브모듈 설치
MagicMirror의 modules 디렉토리에 MMM-EmbedURL을 설치합니다.
cd ~/MagicMirror/modules

# 저장소 클론
git clone https://github.com/Tom-Hirschberger/MMM-EmbedURL
cd MMM-EmbedURL

# 모듈 의존성 설치
npm install


---
2.3 nginx 설치 및 설정
로컬 HTML Report 파일을 HTTP로 서빙하기 위해 nginx를 시스템에 직접 설치합니다. apt 패키지를 사용하므로 별도 컨테이너 없이 systemd로 관리됩니다.
서빙 디렉토리 준비
Report HTML 파일을 저장할 디렉토리를 생성하고 nginx 접근 권한을 설정합니다.
# 서빙 디렉토리 생성
sudo mkdir -p /var/www/vividmirror

# pi 계정 소유권 설정 (파일 배포 편의를 위해)
sudo chown -R mirrorvivid:mirrorvivid /var/www/vividmirror
sudo chmod -R 755 /var/www/vividmirror

Nginx 가상호스트 설정 파일 작성
/etc/nginx/sites-available/ 에 MagicMirror 전용 설정 파일을 작성합니다.
sudo nano /etc/nginx/sites-available/vividmirror

server {
    listen 8090;
    server_name localhost;

    root /var/www/vividmirror;
    index vivid.report.html;

    location / {
        try_files $uri $uri/ =404;
        add_header Access-Control-Allow-Origin *;
        add_header X-Frame-Options ALLOWALL;
    }
}

사이트 활성화
sites-available 설정을 sites-enabled에 심볼릭 링크로 등록합니다.
# 사이트 활성화
sudo ln -s /etc/nginx/sites-available/vividmirror \
           /etc/nginx/sites-enabled/vividmirror

# 설정 문법 검사
sudo nginx -t
동작 확인
# 서비스 재시작
sudo systemctl restart nginx

# 서비스 상태 확인
systemctl status nginx

# 테스트 파일 생성 후 접속 확인
curl http://localhost:8090/


---
3. 모듈 설정
3.1 API 토큰 설정(미사용)
MagicMirror는 날씨, 캘린더 등 외부 API 연동 시 토큰이 필요합니다. 토큰은 config.js에 직접 입력하거나 별도 파일로 분리 관리합니다.
환경변수 파일 분리 (권장)
보안을 위해 토큰을 별도 파일로 관리합니다.
# ~/.env.magicmirror
MM_WEATHER_API_KEY=your_openweather_api_key_here
MM_CALENDAR_URL=https://your-calendar-url.ics

config.js에서 환경변수 로드
// ~/MagicMirror/config/config.js 상단
require('dotenv').config({ path: '/home/pi/.env.magicmirror' });

// 모듈 설정에서 사용 예시
modules: [
  {
    module: 'currentweather',
    config: {
      apiKey: process.env.MM_WEATHER_API_KEY,
    }
  }
]

💡 .env.magicmirror 파일은 chmod 600 으로 권한을 제한하여 다른 사용자의 접근을 차단하세요.
dotenv 패키지 설치
cd ~/MagicMirror
npm install dotenv

---
3.2 Report HTML 서빙 설정
생성된 HTML 리포트 파일을 nginx를 통해 서빙하고, MMM-EmbedURL로 MagicMirror에 임베드합니다.
HTML 파일 배포

다운로드하여, 아래 경로에 위치
cp ~/Downloads/vivid.report.html /var/www/vividmirror

# nginx 재시작
sudo systemctl reload nginx
토큰 획득 
*매번 갱신이 필요합니다, 갱신필요시 소프트웨어 개발자에 문의하세요
**아래링크에서 획득할 수 있습니다.
 

브라우저에서 확인
http://localhost:8090?token=<YOUR_TOKEN>
MMM-EmbedURL config.js 설정

config.js의 modules 배열에 MMM-EmbedURL 설정을 추가합니다.
{
  module: 'MMM-EmbedURL',
  position: 'fullscreen_below',  // 전체화면 또는 원하는 위치
  config: {
    updateInterval: 300,          // 5분마다 새로고침
    embedElementType: 'webview',  // 로컬 파일은 webview 권장
    basicElementType: 'div',      // webview 시 반드시 div
    attributes: [
      'frameborder=0',
    ],
    embed: [
      'http://localhost:8090?token=eyJhbGciOiJIUzI1NiIsImtpZCI6IkhGRnl1akN0WUpERVZsUEgiLCJ0eXAiOiJKV1QifQ.eyJpc3MiOiJodHRwczovL21vZ2pxbGh6eHFqdXZmZmRpemxjLnN1cGFiYXNlLmNvL2F1dGgvdjEiLCJzdWIiOiJlMmNiNjY5Ni05YmEwLTQ5MWItYmEzNS00ZTI4NTM4OTM1ZjIiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNzczNDYyNDQzLCJpYXQiOjE3NzI4NTc2NDMsImVtYWlsIjoidGVzdGVyQG5hdmVyLmNvbSIsInBob25lIjoiIiwiYXBwX21ldGFkYXRhIjp7InByb3ZpZGVyIjoiZW1haWwiLCJwcm92aWRlcnMiOlsiZW1haWwiXX0sInVzZXJfbWV0YWRhdGEiOnsiYWdyZWVBSSI6dHJ1ZSwiYWdyZWVNYXJrZXRpbmciOnRydWUsImFncmVlVGVybXMiOnRydWUsImJpcnRoWWVhciI6IjE5OTQiLCJjYWNoZV9idXN0IjoiMjAyNi0wMi0xNVQwMTo1MzoxMS43MzRaIiwiZW1haWwiOiJ0ZXN0ZXJAbmF2ZXIuY29tIiwiZW1haWxfdmVyaWZpZWQiOnRydWUsImV4Y2x1ZGVfdG9kb19jb21wbGV0aW9uIjp0cnVlLCJnZW5kZXIiOiJtYWxlIiwibGFzdF9sb2dpbl9hdCI6IjIwMjYtMDMtMDZUMDQ6MzE6MTAuOTA2WiIsIm5hbWUiOiLquYDsp4DsmrAo6rO16rCE7YGQ66CI7J207YSwKSIsInBob25lIjoiMDEwNDEyNjM2MTEiLCJwaG9uZV92ZXJpZmllZCI6ZmFsc2UsInBob25lX3ZlcmlmaWVkX2F0IjoiMjAyNi0wMS0xNVQwNDo0Njo1MS43MDNaIiwic3ViIjoiZTJjYjY2OTYtOWJhMC00OTFiLWJhMzUtNGUyODUzODkzNWYyIiwic3Vic2NyaXB0aW9uIjp7ImV4cGlyZXNfYXQiOiIyMTAwLTAxLTI2IiwicGxhbiI6InBybyIsInN0YXJ0ZWRfYXQiOiIyMDI2LTAxLTI3Iiwic3RhdHVzIjoiYWN0aXZlIiwidXBkYXRlZF9hdCI6IjIwMjYtMDMtMDZUMDQ6MjA6NDQuMjUzWiJ9LCJ1c2VkX2NvdXBvbnMiOlt7ImNvZGUiOiJXRUxDT01FMzAiLCJpZCI6ImY4MTE4MGEzLWFmYjYtNDk4Ni05YzcwLWRhMmU5YjljOGM5MCJ9XX0sInJvbGUiOiJhdXRoZW50aWNhdGVkIiwiYWFsIjoiYWFsMSIsImFtciI6W3sibWV0aG9kIjoicGFzc3dvcmQiLCJ0aW1lc3RhbXAiOjE3NzI4NTc2NDN9XSwic2Vzc2lvbl9pZCI6ImQxZTk0YTEwLTM4ZmEtNDY3OC04ZDIzLWFjMDdjNzNiODQ2ZSIsImlzX2Fub255bW91cyI6ZmFsc2V9.xH7LQG9TaTlSHdptDs78Lchgl2qAckRwcNhPLWTTMYY''
    ]
  },
},

CSS로 크기 조정(옵션)
~/MagicMirror/css/custom.css 에 아래 스타일을 추가하여 임베드 영역 크기를 조정합니다.
/* ~/MagicMirror/css/custom.css */
.MMM-EmbedURL .embed .embeded {
    width: 1280px;
    height: 720px;
    border: none;
}

---
4. MagicMirror 실행
4.1 수동 실행
터미널에서 직접 실행하여 동작을 확인합니다.
GUI 환경 (X서버)
cd ~/MagicMirror
npm start


---
4.2 서비스 자동 시작 설정 (systemd)
부팅 시 자동으로 MagicMirror가 실행되도록 systemd 서비스를 등록합니다.
서비스 파일 생성
sudo nano /etc/systemd/system/magicmirror.service

둘 중 하나 맘에 드는 것을 골라서 설정
[Unit]
Description=MagicMirror
After=lightdm.service
Wants=lightdm.service

[Service]
Type=simple
User=sm
Environment=DISPLAY=:0
Environment=XAUTHORITY=/home/sm/.Xauthority
WorkingDirectory=/home/sm/MagicMirror
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=10

[Install]
WantedBy=graphical.target
[Unit]
Description=MagicMirror
After=network.target

[Service]
Type=simple
User=sm
WorkingDirectory=/home/sm/MagicMirror
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=10
Environment=DISPLAY=:0
Environment=XAUTHORITY=/home/sm/.Xauthority

[Install]
WantedBy=multi-user.target


서비스 등록 및 시작
sudo systemctl daemon-reload
sudo systemctl enable magicmirror
sudo systemctl start magicmirror

# 상태 확인
sudo systemctl status magicmirror

---
4.3 실행 상태 확인
정상 동작 여부를 아래 명령으로 확인합니다.

---
4.4 트러블슈팅
