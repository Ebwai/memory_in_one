"""Loopback-only SSH fixture; never reads or changes the user's SSH configuration."""
import base64
import hashlib
import json
import select
import socket
import threading
from pathlib import Path
import paramiko

key = paramiko.ECDSAKey.generate()
fingerprint = 'SHA256:' + base64.b64encode(hashlib.sha256(key.asbytes()).digest()).decode().rstrip('=')
Path('.build/android/ssh-fixture.json').write_text(json.dumps({'host':'127.0.0.1','user':'android-test','password':'fixture-password','port':22223,'remotePort':49161,'localPort':42081,'fingerprint':fingerprint}))

class Server(paramiko.ServerInterface):
    destinations = {}
    def check_auth_password(self, username, password):
        return paramiko.AUTH_SUCCESSFUL if username == 'android-test' and password == 'fixture-password' else paramiko.AUTH_FAILED
    def get_allowed_auths(self, username):
        return 'password'
    def check_channel_direct_tcpip_request(self, channel_id, origin, destination):
        if destination != ('127.0.0.1', 49161):
            return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED
        self.destinations[channel_id] = destination
        return paramiko.OPEN_SUCCEEDED

def pipe(channel, destination):
    peer = socket.create_connection(destination, timeout=5)
    try:
        while True:
            readers, _, _ = select.select([channel, peer], [], [], 10)
            for reader in readers:
                data = reader.recv(65536)
                if not data:
                    return
                (peer if reader is channel else channel).sendall(data)
    finally:
        channel.close()
        peer.close()

def serve(connection):
    transport = paramiko.Transport(connection)
    transport.add_server_key(key)
    server = Server()
    try:
        transport.start_server(server=server)
        while transport.is_active():
            channel = transport.accept(1)
            if channel:
                threading.Thread(target=pipe,args=(channel,server.destinations[channel.get_id()]),daemon=True).start()
    except Exception:
        transport.close()

listener = socket.socket()
listener.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1)
listener.bind(('127.0.0.1',22223))
listener.listen(5)
print('Temporary SSH fixture ready',flush=True)
while True:
    connection,_ = listener.accept()
    threading.Thread(target=serve,args=(connection,),daemon=True).start()
