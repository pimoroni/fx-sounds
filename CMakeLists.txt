cmake_minimum_required(VERSION 3.16)
project(fx-sounds CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release)
endif()

set(ENGINE_SOURCES
  src/patch.cpp
  src/synth.cpp
  src/reverb.cpp
)

if(EMSCRIPTEN)
  add_executable(fxengine src/wasm.cpp ${ENGINE_SOURCES})
  target_include_directories(fxengine PRIVATE src)
  target_compile_options(fxengine PRIVATE -Wall -Wextra -fexceptions)
  target_link_options(fxengine PRIVATE
    -lembind
    -fexceptions
    -sMODULARIZE=1
    -sEXPORT_ES6=1
    -sEXPORT_NAME=createEngine
    -sENVIRONMENT=web,worker,node
    -sALLOW_MEMORY_GROWTH=1
    -sMAXIMUM_MEMORY=4GB
  )
  return()
endif()

add_library(fxcore STATIC
  ${ENGINE_SOURCES}
  src/wav.cpp
  src/preview.cpp
)
find_package(ZLIB REQUIRED)
target_link_libraries(fxcore PUBLIC ZLIB::ZLIB)
target_include_directories(fxcore PUBLIC src)
target_compile_options(fxcore PRIVATE -Wall -Wextra)

add_executable(fx-sounds src/main.cpp)
target_link_libraries(fx-sounds PRIVATE fxcore)

enable_testing()
add_executable(loop_check tests/loop_check.cpp)
target_link_libraries(loop_check PRIVATE fxcore)
file(GLOB PRESET_FILES ${CMAKE_SOURCE_DIR}/presets/*.ini)
add_test(NAME loop_check COMMAND loop_check ${PRESET_FILES})
